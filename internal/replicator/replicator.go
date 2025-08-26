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
	Run(context.Context) error
}

type replicator struct {
	jobs    []config.ReplicationJob
	sources []source.Source
	targets []target.Target
}

func New(opts ...Option) Replicator {
	repli := &replicator{}

	for _, opt := range opts {
		opt(repli)
	}

	return repli
}

func (repli *replicator) Run(ctx context.Context) error {
	for _, job := range repli.jobs {
		fmt.Printf("replicator %q Run\n", job.Name)

		// srcCfg := src.Lookup(job.Source)
		// tarCfg := tar.Lookup(job.Target)

	}

	return nil
}

func WithJobsOptions(jobs []config.ReplicationJob) Option {
	return func(r *replicator) {
		r.jobs = jobs
	}
}

func WithSourcesOptions(srcs []source.Source) Option {
	return func(r *replicator) {
		r.sources = srcs
	}
}

func WithTargetsOptions(tars []target.Target) Option {
	return func(r *replicator) {
		r.targets = tars
	}
}
