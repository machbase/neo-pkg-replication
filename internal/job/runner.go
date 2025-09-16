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

	interval         time.Duration
	delay            time.Duration
	batchWindowLimit time.Duration

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

		if err := r.src.Open(c); err != nil {
			r.report(fmt.Errorf("%s: failed to open source: %v", r.name, err))
			return
		}
		defer r.src.Close(c)

		if err := r.tar.Open(c); err != nil {
			r.report(fmt.Errorf("%s: failed to open target: %v", r.name, err))
			return
		}
		defer r.tar.Close(c)

		cursor, err := r.store.Load()
		if err != nil {
			r.report(fmt.Errorf("failed to load store %q: %v", r.spec.CheckPoint, err))
			return
		}

		// 최초 실행 시 한 번 실행
		// r.RunCycle(c)

		ticker := time.NewTicker(r.interval)
		defer ticker.Stop()

		for {
			select {
			case <-c.Done():
				return
			case <-ticker.C:
				until := time.Now().Add(-r.delay)
				from := cursor

				for {
					if !from.Before(until) {
						break
					}

					to := from.Add(r.batchWindowLimit)
					if to.After(until) {
						to = until
					}
					if !from.Before(to) {
						break
					}

					next, err := r.RunCycle(c, from, to)
					if err != nil {
						r.report(fmt.Errorf("failed to run cycle: %v", err))
						return
					}

					if !next.After(from) {
						next = to
					}

					if err := r.store.Save(next); err != nil {
						r.report(fmt.Errorf("failed to save checkpoint: %v", err))
						return
					}
					cursor, from = next, next
				}
			}
		}
	}()

	return nil
}

func (r *runner) RunCycle(ctx context.Context, from time.Time, to time.Time) (time.Time, error) {
	r.log.Info("run cycle!")

	// data, err := r.src.Read(ctx)
	// if err != nil {
	// 	return time.Now(), err
	// }

	// r.tar.Write()

	return time.Now(), nil
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
		r.log.Info("runner stop")
		r.cancel()
	}

	return nil
}

func (r *runner) Errors() <-chan error { return r.errCh }
