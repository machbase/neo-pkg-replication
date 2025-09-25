package source

import (
	"context"
	"fmt"
	"net/url"
	"repli/config"
	"repli/internal/machbase"
	"repli/internal/ports"
	"strings"
)

type machbaseSource struct {
	name   string
	driver string
	conn   config.ConnSpec

	cli *machbase.Client
}

func newMachbase(spec config.SourceSpec) (*machbaseSource, error) {
	return &machbaseSource{
		name:   spec.Name,
		driver: spec.Type,
		conn:   spec.Connection,
	}, nil
}

func (m *machbaseSource) Name() string {
	return m.name
}

func (m *machbaseSource) Open(ctx context.Context) error {
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

func (m *machbaseSource) Close(ctx context.Context) error {
	return nil
}

func (m *machbaseSource) NewReader(ctx context.Context, table, seqExpr string, columns []string) (ports.SourceReader, error) {
	if m.cli == nil {
		return nil, fmt.Errorf("machbase source not opened")
	}

	table = strings.TrimSpace(table)
	seqExpr = strings.TrimSpace(seqExpr)

	reader := &machbaseReader{
		table:   table,
		seqExpr: seqExpr,
		columns: columns,
		cli:     m.cli,
	}

	return reader, nil
}

func (m *machbaseSource) Driver() string {
	return m.driver
}

func (m *machbaseSource) SupportsKind(kind string) bool {
	switch strings.ToLower(kind) {
	case "tag", "log":
		return true
	default:
		return false
	}
}

func (m *machbaseSource) TableExists(ctx context.Context, table string) (bool, error) {
	return m.cli.TableExists(ctx, table)
}
