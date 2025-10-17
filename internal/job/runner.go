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

func (r *runner) saveCheckPoint(checkpoint offset.CheckPoint) error {
	return r.store.Save(checkpoint)
}

func (r *runner) loadCheckPoint() (offset.CheckPoint, error) {
	return r.store.Load()
}

func (r *runner) runLoop(ctx context.Context, chk offset.CheckPoint) {
	// 최초 실행 시 한 번 실행
	next, err := r.RunCycle(ctx, chk)
	if err != nil {
		r.report(fmt.Errorf("failed to run cycle: %v", err))
		return
	}
	chk = next

	ticker := time.NewTicker(r.interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			next, err := r.RunCycle(ctx, chk) // 메서드 이름 변경
			if err != nil {
				r.report(fmt.Errorf("failed to run cycle: %v", err))
				continue // 본부장님께 질문
				// return
			}
			if err := r.saveCheckPoint(next); err != nil {
				r.report(fmt.Errorf("failed to save checkpoint: %v", err))
				continue

				// return
			}
			chk = next
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

		exists, err := r.validateTables(c)
		if err != nil {
			r.report(err)
			return
		}
		if !exists {
			r.report(err)
			return
		}

		checkpoint, err := r.loadCheckPoint()
		if err != nil {
			r.report(fmt.Errorf("failed to load store %q: %v", r.spec.CheckPoint, err))
			return
		}

		r.runLoop(c, checkpoint)
	}()

	return nil
}

func (r *runner) validateTables(ctx context.Context) (bool, error) {
	// source table exists
	exists, err := r.src.TableExists(ctx, r.spec.TableMap.Source)
	if err != nil {
		return false, fmt.Errorf("failed to request exists: %v", err)
	}
	if !exists {
		return false, fmt.Errorf("%q table is not exists: %v", r.spec.TableMap.Source, err)
	}

	// target table exists
	exists, err = r.tar.TableExists(ctx, r.spec.TableMap.Target)
	if err != nil {
		return false, fmt.Errorf("failed to request exists: %v", err)
	}
	if !exists {
		return false, fmt.Errorf("%q table is not exists: %v", r.spec.TableMap.Source, err)
	}

	return true, nil
}

func (r *runner) RunCycle(ctx context.Context, chk offset.CheckPoint) (offset.CheckPoint, error) {
	until := time.Now().Add(-r.delay)
	from := chk.Cursor

	if !from.Before(until) {
		chk.Cursor = from
		return chk, nil
	}

	reader, err := r.src.NewReader(ctx, r.spec.TableMap.Source, r.spec.TableMap.SeqExpr, r.spec.TableMap.Columns)
	if err != nil {
		return offset.CheckPoint{}, fmt.Errorf("failed to create reader: %v", err)
	}
	defer reader.Close(ctx)
	if err := reader.Prepare(ctx); err != nil {
		return offset.CheckPoint{}, fmt.Errorf("failed to prepare reader: %v", err)
	}

	writer, err := r.tar.NewWriter(ctx, r.spec.TableMap.Target, r.spec.TableMap.SeqExpr, r.spec.TableMap.Columns)
	if err != nil {
		return offset.CheckPoint{}, fmt.Errorf("failed to create writer: %v", err)
	}
	defer writer.Close(ctx)
	if err := writer.Prepare(ctx); err != nil {
		return offset.CheckPoint{}, fmt.Errorf("failed to prepare writer: %v", err)
	}

	mr, hasMetaRead := reader.(ports.MetaReader)
	mw, hasMetaWrite := writer.(ports.MetaWriter)

	metaOffset := chk.MetaOffset
	for {
		to := from.Add(r.batchWindowLimit)
		if to.After(until) {
			to = until
		}

		if !from.Before(to) {
			break
		}

		if r.spec.Options.UseMeta && hasMetaRead && hasMetaWrite {
			batch, err := mr.ReadMeta(ctx, metaOffset)
			if err != nil {
				return offset.CheckPoint{}, fmt.Errorf("failed to read meta: %v", err)
			}
			metaOffset, err := mw.WriteMeta(ctx, batch)
			if err != nil {
				return offset.CheckPoint{}, fmt.Errorf("failed to write meta: %v", err)
			}
			chk.MetaOffset = metaOffset
		}

		batch, err := reader.ReadRange(ctx, ports.Range{From: from, To: to, Rid: chk.LastRID})
		if err != nil {
			return offset.CheckPoint{}, fmt.Errorf("failed to read range: %v", err)
		}

		_, err = writer.WriteBatch(ctx, batch)
		if err != nil {
			return offset.CheckPoint{}, fmt.Errorf("failed to write batch: %v", err)
		}

		from = to
	}

	return chk, nil
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
