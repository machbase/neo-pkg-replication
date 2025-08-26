package replicator

import (
	"context"
	"fmt"
	"repli/config"
	"repli/internal/source"
	"repli/internal/target"
)

type Option func(*replicator)

type Replicator interface {
	Run(context.Context, []source.Source, []target.Target) error
}

type replicator struct {
	jobs []config.ReplicationJob
	src  source.Source
	tar  target.Target
}

func New(jobs ...config.ReplicationJob) Replicator {
	repli := &replicator{
		jobs: make([]config.ReplicationJob, 0, len(jobs)),
		// src:  src,
		// tar:  tar,
	}
	repli.jobs = append(repli.jobs, jobs...)

	return repli
}

func (repli *replicator) Run(ctx context.Context, srcs []source.Source, tars []target.Target) error {
	for _, job := range repli.jobs {
		fmt.Printf("replicator %q Run\n", job.Name)

		// srcCfg := src.Lookup(job.Source)
		// tarCfg := tar.Lookup(job.Target)

	}

	return nil
}

func WithDBOptions(dbOption string) Option {
	return func(r *replicator) {
	}
}
