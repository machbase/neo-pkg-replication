package job

import (
	"context"
	"errors"
	"fmt"
	"os"
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

	interval time.Duration
	// RID
	ridLimit int64

	// TIMESTAMP
	delay            time.Duration
	batchWindowLimit time.Duration

	errCh  chan error
	cancel context.CancelFunc

	store offset.Store
	log   *logrus.Entry
}

func (r *runner) runLoop(ctx context.Context, chk offset.CheckPoint) {
	// 최초 실행 시 한 번 실행
	nextCheckPoint, err := r.RunCycle(ctx, chk)
	if err != nil {
		r.report(fmt.Errorf("failed to run cycle: %v", err))
		return
	}
	if err := r.saveCheckPoint(nextCheckPoint); err != nil {
		r.report(fmt.Errorf("failed to save checkpoint: %v", err))
		return
	}
	chk = nextCheckPoint

	ticker := time.NewTicker(r.interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			nextCheckPoint, err := r.RunCycle(ctx, chk)
			if err != nil {
				r.report(fmt.Errorf("failed to run cycle: %v", err))
				continue
			}
			if err := r.saveCheckPoint(nextCheckPoint); err != nil {
				r.report(fmt.Errorf("failed to save checkpoint: %v", err))
				continue
			}
			chk = nextCheckPoint
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
		return false, fmt.Errorf("failed to request exists(source.%s): %v", r.spec.TableMap.Source, err)
	}
	if !exists {
		return false, fmt.Errorf("%q table is not exists: %v", r.spec.TableMap.Source, err)
	}

	// target table exists
	exists, err = r.tar.TableExists(ctx, r.spec.TableMap.Target)
	if err != nil {
		return false, fmt.Errorf("failed to request exists(target.%s): %v", r.spec.TableMap.Target, err)
	}
	if !exists {
		return false, fmt.Errorf("%q table is not exists: %v", r.spec.TableMap.Target, err)
	}

	r.log.Infof("source(%s) & target(%s) table exists", r.spec.TableMap.Source, r.spec.TableMap.Target)

	return true, nil
}

func (r *runner) RunCycle(ctx context.Context, chk offset.CheckPoint) (offset.CheckPoint, error) {
	// Create reader
	reader, err := r.src.NewReader(ctx, r.spec.TableMap.Source, r.spec.TableMap.SeqExpr, r.spec.TableMap.Columns, r.ridLimit)
	if err != nil {
		return offset.CheckPoint{}, fmt.Errorf("failed to create reader: %v", err)
	}
	defer reader.Close(ctx)
	if err := reader.Prepare(ctx); err != nil {
		return offset.CheckPoint{}, fmt.Errorf("failed to prepare reader: %v", err)
	}

	// Create writer
	writer, err := r.tar.NewWriter(ctx, r.spec.TableMap.Target, r.spec.TableMap.SeqExpr, r.spec.TableMap.Columns)
	if err != nil {
		return offset.CheckPoint{}, fmt.Errorf("failed to create writer: %v", err)
	}
	defer writer.Close(ctx)
	if err := writer.Prepare(ctx); err != nil {
		return offset.CheckPoint{}, fmt.Errorf("failed to prepare writer: %v", err)
	}

	// Handle meta replication if enabled
	if r.spec.Options.UseMeta {
		mr, hasMetaRead := reader.(ports.MetaReader)
		mw, hasMetaWrite := writer.(ports.MetaWriter)
		if hasMetaRead && hasMetaWrite {
			batch, err := mr.ReadMeta(ctx, chk.MetaOffset)
			if err != nil {
				return offset.CheckPoint{}, fmt.Errorf("failed to read meta: %v", err)
			}
			metaOffset, err := mw.WriteMeta(ctx, batch)
			if err != nil {
				return offset.CheckPoint{}, fmt.Errorf("failed to write meta: %v", err)
			}
			chk.MetaOffset = metaOffset
		}
	}

	// Create strategy based on mode
	var strategy ReplicationStrategy
	switch chk.Mode {
	case "RID":
		strategy = NewRIDStrategy(r.ridLimit)
	case "TIMESTAMP":
		strategy = NewTimestampStrategy(r.delay, r.batchWindowLimit)
	default:
		return offset.CheckPoint{}, fmt.Errorf("invalid checkpoint mode: %q", chk.Mode)
	}

	// Execute replication using strategy
	return strategy.Execute(ctx, chk, reader, writer)
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

func (r *runner) saveCheckPoint(checkpoint offset.CheckPoint) error {
	return r.store.Save(checkpoint)
}

func (r *runner) loadCheckPoint() (offset.CheckPoint, error) {
	chk, err := r.store.Load()
	if errors.Is(err, os.ErrNotExist) {
		chk = offset.NewCheckPoint(r.spec.TableMap.SeqExpr)

		if err := r.store.Save(chk); err != nil {
			return offset.CheckPoint{}, fmt.Errorf("failed to save inital checkpoint: %v", err)
		}

		r.log.Infof("created inital checkpoint: mode=%s", chk.Mode)
		return chk, nil
	}

	if err != nil {
		return chk, err
	}

	r.log.Infof("loaded checkpoint: mode=%s", chk.Mode)
	return chk, nil
}
