package job

import (
	"context"
	"repli/config"
	"repli/internal/ports"
	"sync"
	"time"
)

type runner struct {
	name string
	spec config.JobSpec
	src  ports.Source
	tar  ports.Target

	// batchSize int

	interval time.Duration
	delay    time.Duration

	// chkpt int64
	chkpt time.Time
	last  time.Time

	errCh  chan error
	wg     sync.WaitGroup
	cancel context.CancelFunc
}

func (r *runner) Name() string {
	return r.name
}

func (r *runner) Start(ctx context.Context) error {
	c, cancel := context.WithCancel(ctx)
	r.cancel = cancel
	//client, err :=
	err := r.src.Open(c)
	if err != nil {
		return err
	}
	//client, err :=
	err = r.tar.Open(c)
	if err != nil {
		return err
	}

	r.wg.Add(1)
	go func() {
		defer r.wg.Done()
		defer close(r.errCh)

		r.RunCycle(c)

		ticker := time.NewTicker(r.interval)

		for {
			select {
			case <-ctx.Done():
				ticker.Stop()
				return
			case <-ticker.C:
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

	r.wg.Wait()

	return nil
}

func (r *runner) Errors() <-chan error { return r.errCh }

func (r *runner) RunCycle(ctx context.Context) error {
	// 최초 실행
	waterMark := time.Now().Add(-r.delay)
	waterMark.After(r.last)

	// 주기적 실행

	return nil
}
