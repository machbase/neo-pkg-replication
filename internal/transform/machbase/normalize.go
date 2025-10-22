package machbase

import (
	"context"
	"repli/internal/ports"
)

type MachbaseToCIS struct {
}

func NewMachbaseToCIS() ports.Transformer {
	return &MachbaseToCIS{}
}

func (tc *MachbaseToCIS) Prepare(ctx context.Context) error {
	return nil
}
func (tc *MachbaseToCIS) Transform(ctx context.Context, batch ports.Batch) (ports.Batch, error) {
	return ports.Batch{}, nil
}
func (tc *MachbaseToCIS) Close(ctx context.Context) error {
	return nil
}
