package source

import (
	"context"
	"fmt"
	"net/url"
	"repli/config"
	"repli/internal/machbase"
)

type machbaseSource struct {
	name string
	conn config.ConnSpec

	cli *machbase.Client
}

func newMachbase(spec config.SourceSpec) (*machbaseSource, error) {
	return &machbaseSource{
		name: spec.Name,
		conn: spec.Connection,
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

	// ping/health Check

	return nil
}

func (m *machbaseSource) Close(ctx context.Context) error {
	return nil
}

// 가져올 테이블 이름과, 컬럼들 필요 (JOB에 있음)
func (m *machbaseSource) Read(ctx context.Context) ([][]any, error) {
	return nil, nil
}
