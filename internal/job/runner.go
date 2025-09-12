package job

import (
	"context"
	"fmt"
	"repli/config"
	"repli/internal/offset"
	"repli/internal/ports"
	"time"

	"github.com/sirupsen/logrus"
)

type runner struct {
	name string

	spec config.JobSpec
	src  ports.Source
	tar  ports.Target

	// batchSize int

	interval time.Duration
	delay    time.Duration

	errCh  chan error
	cancel context.CancelFunc

	store offset.Store
	log   *logrus.Entry
}

func (r *runner) Name() string {
	return r.name
}

func (r *runner) Start(ctx context.Context) error {
	c, cancel := context.WithCancel(ctx)
	r.cancel = cancel

	last, err := r.store.Load()
	if err != nil {
		return fmt.Errorf("failed to load store %q: %v", r.spec.CheckPoint, err)
	}

	// Source
	if err = r.src.Open(c); err != nil {
		return fmt.Errorf("%s: failed to open source: %v", r.name, err)
	}
	defer r.src.Close(c)

	// Target
	if err = r.tar.Open(c); err != nil {
		return fmt.Errorf("%s: failed to open target: %v", r.name, err)
	}
	defer r.tar.Close(c)

	ticker := time.NewTicker(r.interval)
	go func() {
		r.log.Info("Runner Start")
		r.log.Error("halo")
		defer func(name string) { r.log.Infof("close Runner: %q\n", name) }(r.Name())
		r.RunCycle(c)

		for {
			from := last
			to := time.Now().Add(-r.delay)

			select {
			case <-ctx.Done():
				ticker.Stop()
				return
			case <-ticker.C:
				if to.Sub(from) > r.delay {
					continue
				}

				_ = r.RunCycle(c)
			}
		}

	}()

	return nil
}

func (r *runner) Stop() error {
	if r.cancel != nil {
		r.cancel()
	}

	return nil
}

func (r *runner) Errors() <-chan error { return r.errCh }

func (r *runner) RunCycle(ctx context.Context) error {
	// 최초 실행
	// waterMark := time.Now().Add(-r.delay)
	// waterMark.After(r.last)

	// 주기적 실행

	return nil
}
