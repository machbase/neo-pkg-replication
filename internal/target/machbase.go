package target

import (
	"context"
	"fmt"
	"repli/config"
	"repli/internal/machbase"
)

type machbaseTarget struct {
	name string
	conn config.ConnSpec
	cli  *machbase.Client
}

func newMachbase(spec config.TargetSpec) *machbaseTarget {
	base := fmt.Sprintf("%s:%d", spec.Connection.Host, spec.Connection.Port)
	cli, err := machbase.NewClient(base, nil)
	if err != nil {

	}
	return &machbaseTarget{name: spec.Name, conn: spec.Connection, cli: cli}
}

func (m *machbaseTarget) Name() string {
	return m.name
}

func (m *machbaseTarget) Open(ctx context.Context) error {
	return nil
}

func (m *machbaseTarget) Close(ctx context.Context) error {
	return nil
}

func (m *machbaseTarget) Write(ctx context.Context, rows [][]any) error {
	return nil
}
