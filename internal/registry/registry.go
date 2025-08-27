package registry

import (
	"fmt"
	"repli/config"
	"repli/internal/ports"
	"repli/internal/source"
	"repli/internal/target"
)

type Registry struct {
	sources map[string]ports.Source
	targets map[string]ports.Target
}

func New(sourceSpec []config.SourceSpec, targetSpec []config.TargetSpec) (*Registry, error) {
	srcs, err := source.Build(sourceSpec...)
	if err != nil {
		return nil, fmt.Errorf("failed to build sources: %v", err)
	}
	tars, err := target.Build(targetSpec...)
	if err != nil {
		return nil, fmt.Errorf("failed to build targets: %v", err)
	}

	registry := &Registry{sources: srcs, targets: tars}
	if err := registry.validate(); err != nil {
		return nil, fmt.Errorf("failed to validate registry: %v", err)
	}

	return registry, nil
}

func (r *Registry) validate() error {
	return nil
}

func (r *Registry) GetSource(name string) (ports.Source, error) {
	if src, ok := r.sources[name]; ok {
		return src, nil
	}
	return nil, fmt.Errorf("source %q not found", name)
}

func (r *Registry) GetTarget(name string) (ports.Target, error) {
	if tar, ok := r.targets[name]; ok {
		return tar, nil
	}
	return nil, fmt.Errorf("target %q not found", name)
}
