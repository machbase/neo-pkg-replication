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

func (r *runner) openResources(ctx context.Context) (func(), error) {
	if err := r.src.Open(ctx); err != nil {
		return func() {}, fmt.Errorf("%s: failed to open source: %v", r.name, err)
	}

	if err := r.tar.Open(ctx); err != nil {
		r.src.Close(ctx)
		return func() {}, fmt.Errorf("%s: failed to open target: %v", r.name, err)
	}

	return func() {
		r.tar.Close(ctx)
		r.src.Close(ctx)
	}, nil
}

func (r *runner) loadCheckPoint() (time.Time, error) {
	return r.store.Load()
}

func (r *runner) runLoop(ctx context.Context, cursor time.Time) {
	// 최초 실행 시 한 번 실행
	next, err := r.RunCycle(ctx, cursor)
	if err != nil {
		r.report(fmt.Errorf("failed to run cycle: %v", err))
		return
	}
	cursor = next

	ticker := time.NewTicker(r.interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			next, err := r.RunCycle(ctx, cursor)
			if err != nil {
				r.report(fmt.Errorf("failed to run cycle: %v", err))
				return
			}
			if err := r.store.Save(next); err != nil {
				r.report(fmt.Errorf("failed to save checkpoint: %v", err))
				return
			}
			cursor = next
		}
	}
}

func (r *runner) Start(ctx context.Context) error {
	c, cancel := context.WithCancel(ctx)
	r.cancel = cancel

	go func() {
		defer close(r.errCh)

		cleanup, err := r.openResources(c)
		if err != nil {
			r.report(fmt.Errorf("failed to open resources: %v", err))
			return
		}
		defer cleanup()

		cursor, err := r.loadCheckPoint()
		if err != nil {
			r.report(fmt.Errorf("failed to load store %q: %v", r.spec.CheckPoint, err))
			return
		}

		r.runLoop(c, cursor)

	}()

	return nil
}

func (r *runner) RunCycle(ctx context.Context, cursor time.Time) (time.Time, error) {
	r.log.Info("run cycle!")

	until := time.Now().Add(-r.delay)
	from := cursor

	if !from.Before(until) {
		return from, nil
	}

	reader, err := r.src.NewReader(ctx, r.spec.TableMap.Source, r.spec.TableMap.SeqExpr, r.spec.TableMap.Columns)
	if err != nil {
		return time.Time{}, fmt.Errorf("failed to create reader: %v", err)
	}
	defer reader.Close(ctx)

	if err := reader.Prepare(ctx); err != nil {
		return time.Time{}, fmt.Errorf("failed to prepare reader: %v", err)
	}

	writer, err := r.tar.NewWriter(ctx, r.spec.TableMap.Target, r.spec.TableMap.SeqExpr, r.spec.TableMap.Columns)
	if err != nil {
		return time.Time{}, fmt.Errorf("failed to create writer: %v", err)
	}
	defer writer.Close(ctx)

	if err := writer.Prepare(ctx); err != nil {
		return time.Time{}, fmt.Errorf("failed to prepare writer: %v", err)
	}

	for {
		to := from.Add(r.batchWindowLimit)
		if to.After(until) {
			to = until
		}

		if !from.Before(to) {
			break
		}

		batch, err := reader.ReadRange(ctx, ports.Range{From: from, To: to})
		if err != nil {
			return time.Time{}, fmt.Errorf("failed to read range: %v", err)
		}

		_, err = writer.WriteBatch(ctx, batch)
		if err != nil {
			return time.Time{}, fmt.Errorf("failed to write batch: %v", err)
		}

		from = to
	}

	return from, nil
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
		r.log.Infof("%q runner stop", r.name)
		r.cancel()
	}

	return nil
}

func (r *runner) Errors() <-chan error { return r.errCh }
