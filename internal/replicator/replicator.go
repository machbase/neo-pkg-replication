package replicator

import (
	"context"
	"repli/internal/source"
	"repli/internal/target"
)

type Replicator interface {
	Run(ctx context.Context) error
}

type Option func(*replicator)

type replicator struct {
}

func New(src source.Source, tar target.Target) {

}

func WithDBOptions(dbOption string) Option {
	return func(r *replicator) {
	}
}
