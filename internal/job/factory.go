package job

import (
	"context"
	"fmt"
	"repli/config"
	"repli/internal/offset"
	"repli/internal/ports"
	"repli/internal/registry"
	"time"

	"github.com/sirupsen/logrus"
)

type Runner interface {
	Name() string
	Start(context.Context) error
	Stop() error
	Errors() <-chan error
}

func Build(specs []config.JobSpec, reg *registry.Registry, root *logrus.Logger) ([]Runner, error) {
	out := make([]Runner, 0, len(specs))

	for _, spec := range specs {
		src, err := reg.GetSource(spec.Source)
		if err != nil {
			return nil, err
		}
		tar, err := reg.GetTarget(spec.Target)
		if err != nil {
			return nil, err
		}

		if err := validateResolved(spec, src, tar); err != nil {
			return nil, err
		}

		child := logrus.NewEntry(root).WithField("runner", spec.Name)

		runner, err := newRunnerResolved(spec, src, tar, child)
		if err != nil {
			return nil, err
		}
		out = append(out, runner)
	}

	return out, nil
}

func newRunnerResolved(spec config.JobSpec, src ports.Source, tar ports.Target, lg *logrus.Entry) (*runner, error) {
	interval, err := time.ParseDuration(spec.Options.Interval)
	if err != nil {
		return nil, fmt.Errorf("failed to parse interval %q: %v", spec.Options.Interval, err)
	}
	delay, err := time.ParseDuration(spec.Options.Delay)
	if err != nil {
		return nil, fmt.Errorf("failed to parse delay %q: %v", spec.Options.Delay, err)
	}
	batchWindowLimit, err := time.ParseDuration(spec.Options.BatchWindowLimit)
	if err != nil {
		return nil, fmt.Errorf("failed to parse batch_window_limit %q: %v", spec.Options.BatchWindowLimit, err)
	}
	store := offset.NewFileStore(spec.CheckPoint)

	return &runner{
		name:             spec.Name,
		spec:             spec,
		src:              src,
		tar:              tar,
		interval:         interval,
		delay:            delay,
		batchWindowLimit: batchWindowLimit,
		errCh:            make(chan error, 1),
		store:            store,
		log:              lg,
	}, nil
}

func validateResolved(spec config.JobSpec, src ports.Source, tar ports.Target) error {
	if src == nil || tar == nil {
		return fmt.Errorf("source(%v) or target(%v) is nil", src, tar)
	}

	srcDesc, ok := src.(ports.Describer)
	if !ok {
		return fmt.Errorf("not implement source Describer: %q", src.Name())
	}
	tarDesc, ok := tar.(ports.Describer)
	if !ok {
		return fmt.Errorf("not implement target Describer: %q", tar.Name())
	}

	if srcDesc.Driver() != tarDesc.Driver() {
		return fmt.Errorf("mismatch driver source(%s) != target(%s)", srcDesc.Driver(), tarDesc.Driver())
	}

	if spec.Kind == "" {
		return fmt.Errorf("[%s] kind is required", spec.Name)
	}

	if !srcDesc.SupportsKind(spec.Kind) || !tarDesc.SupportsKind(spec.Kind) {
		return fmt.Errorf("not support kind(%s), source(%s), target(%s)", spec.Kind, srcDesc.Driver(), tarDesc.Driver())
	}
	return nil
}
