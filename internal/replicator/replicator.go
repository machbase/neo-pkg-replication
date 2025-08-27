package replicator

import (
	"context"
	"repli/internal/job"
)

type Replicator struct {
	jobs []job.Runner
}

func New(jobs ...job.Runner) *Replicator {
	return &Replicator{jobs: jobs}
}

func (repli *Replicator) StartAll(ctx context.Context) error {
	for _, job := range repli.jobs {
		if err := job.Start(ctx); err != nil {
			return err
		}
	}
	return nil
}

func (repli *Replicator) StopAll() error {
	for _, job := range repli.jobs {
		if err := job.Stop(); err != nil {
			return err
		}
	}
	return nil
}
