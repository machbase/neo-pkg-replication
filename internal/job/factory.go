package job

import (
	"context"
	"fmt"
	"repli/config"
	"repli/internal/offset"
	"repli/internal/ports"
	"repli/internal/registry"
	"time"
)

type Runner interface {
	Name() string
	Start(context.Context) error
	Stop() error
	Errors() <-chan error
}

func Build(specs []config.JobSpec, reg *registry.Registry) ([]Runner, error) {
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
		runner, err := newRunnerResolved(spec, src, tar)
		if err != nil {
			return nil, err
		}
		out = append(out, runner)
	}

	return out, nil
}

func newRunnerResolved(spec config.JobSpec, src ports.Source, tar ports.Target) (*runner, error) {
	// 에러로 리턴할 지 기본값으로 사용할 지
	interval, err := time.ParseDuration(spec.Options.Interval)
	if err != nil {
		return nil, fmt.Errorf("failed to parse interval %q: %v", spec.Options.Interval, err)
	}
	delay, err := time.ParseDuration(spec.Options.Delay)
	if err != nil {
		return nil, fmt.Errorf("failed to parse delay %q: %v", spec.Options.Delay, err)
	}

	store := offset.NewFileStore(spec.CheckPoint)
	last, err := store.Load()
	if err != nil {
		return nil, fmt.Errorf("failed to load store %q: %v", spec.CheckPoint, err)
	}

	return &runner{
		spec:     spec,
		src:      src,
		tar:      tar,
		interval: interval,
		delay:    delay,
		last:     last,
		errCh:    make(chan error, 1),
	}, nil

}
