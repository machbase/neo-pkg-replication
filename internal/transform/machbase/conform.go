package machbase

import (
	"context"
	"repli/internal/ports"
)

type CISToMachbase struct{}

func NewCISTOMachbase() ports.Transformer {
	return &CISToMachbase{}
}

func (m *CISToMachbase) Prepare(ctx context.Context) error {
	return nil
}
func (m *CISToMachbase) Transform(ctx context.Context, batch ports.Batch) (ports.Batch, error) {
	return ports.Batch{}, nil
}
func (m *CISToMachbase) Close(ctx context.Context) error {
	return nil
}
