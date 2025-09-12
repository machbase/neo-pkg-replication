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

	go func() {
		defer close(r.errCh)

		last, err := r.store.Load()
		if err != nil {
			r.report(fmt.Errorf("failed to load store %q: %v", r.spec.CheckPoint, err))
			return
		}
		if err = r.src.Open(c); err != nil {
			r.report(fmt.Errorf("%s: failed to open source: %v", r.name, err))
			return
		}
		defer r.src.Close(c)

		if err = r.tar.Open(c); err != nil {
			r.report(fmt.Errorf("%s: failed to open target: %v", r.name, err))
			return
		}
		defer r.tar.Close(c)

		// 최초 실행 시 한 번 실행
		// r.RunCycle(c)

		ticker := time.NewTicker(r.interval)
		defer ticker.Stop()

		for {
			from := last
			to := time.Now().Add(-r.delay)

			select {
			case <-c.Done():
				return
			case <-ticker.C:
				// 수정필요
				if to.Sub(from) < r.delay {
					continue
				}

				next, err := r.RunCycle(c)
				if err != nil {
					r.report(fmt.Errorf("failed to run cycel: %v", err))
					return
				}
				last = next
			}
		}
	}()

	return nil
}

func (r *runner) report(err error) {
	if err == nil {
		return
	}

	select {
	case r.errCh <- err:
	default:
		r.log.Errorf("[%s] errCh full, drop: %v", r.name, err)
	}
}

func (r *runner) Stop() error {
	if r.cancel != nil {
		r.cancel()
	}

	return nil
}

func (r *runner) Errors() <-chan error { return r.errCh }

func (r *runner) RunCycle(ctx context.Context) (time.Time, error) {

	return time.Now(), nil
}
