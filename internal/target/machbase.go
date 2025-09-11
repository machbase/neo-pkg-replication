package target

import (
	"context"
	"fmt"
	"net/url"
	"repli/config"
	"repli/internal/machbase"
)

type machbaseTarget struct {
	name string
	conn config.ConnSpec
	cli  *machbase.Client
}

func newMachbase(spec config.TargetSpec) (*machbaseTarget, error) {
	return &machbaseTarget{
		name: spec.Name,
		conn: spec.Connection,
	}, nil
}

func (m *machbaseTarget) Name() string {
	return m.name
}

func (m *machbaseTarget) Open(ctx context.Context) error {
	rawURL := fmt.Sprintf("%s://%s:%d", m.conn.Scheme, m.conn.Host, m.conn.Port)
	u, err := url.Parse(rawURL)
	if err != nil {
		return err
	}

	cli, err := machbase.NewClient(u.String(), nil)
	if err != nil {
		return err
	}
	m.cli = cli

	return nil
}

func (m *machbaseTarget) Close(ctx context.Context) error {
	return nil
}

func (m *machbaseTarget) Write(ctx context.Context, rows [][]any) error {
	return nil
}
