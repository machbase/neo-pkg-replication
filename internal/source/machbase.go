package source

import (
	"context"
	"fmt"
	"repli/config"
	"repli/internal/machbase"
)

type machbaseSource struct {
	name string
	conn config.ConnSpec
	cli  *machbase.Client
}

func newMachbase(spec config.SourceSpec) *machbaseSource {
	base := fmt.Sprintf("%s:%d", spec.Connection.Host, spec.Connection.Port)
	cli, err := machbase.NewClient(base, nil)
	if err != nil {

	}
	return &machbaseSource{name: spec.Name, conn: spec.Connection, cli: cli}
}

func (m *machbaseSource) Name() string {
	return m.name
}
func (m *machbaseSource) Open(ctx context.Context) error {

	return nil
}
func (m *machbaseSource) Close(ctx context.Context) error {
	return nil
}
func (m *machbaseSource) Read(ctx context.Context) ([][]any, error) {
	return nil, nil
}
