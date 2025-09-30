package target

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"repli/internal/machbase"
	"repli/internal/ports"
)

type machbaseWriter struct {
	table   string
	columns []string
	seqExpr string
	useMeta bool

	cli *machbase.Client
}

func (m *machbaseWriter) Prepare(ctx context.Context) error {

	return nil
}

// insert into tag metadata values ('TAG_0002', 99, '2010-01-01', '1.1.1.1');

func (m *machbaseWriter) writeMeta(ctx context.Context, batch ports.Batch) (ports.WriteResult, error) {
	if len(batch.Rows) == 0 {
		return ports.WriteResult{}, nil // 수정?
	}

	path, err := url.JoinPath("/db/write", m.table)
	if err != nil {
		return ports.WriteResult{}, err
	}

	buf := bytes.Buffer{}
	if err := json.NewEncoder(&buf).Encode(batch.Rows); err != nil {
		return ports.WriteResult{}, fmt.Errorf("failed to encode json: %v", err)
	}

	query := url.Values{}
	query.Set("method", "append")

	response, err := m.cli.DoJSON(ctx, http.MethodPost, path, query, &buf)
	if err != nil {
		return ports.WriteResult{}, err
	}
	if !response.Success {
		return ports.WriteResult{}, fmt.Errorf("failed to write: %s", response.Reason)
	}

	return ports.WriteResult{}, nil
}

func (m *machbaseWriter) WriteBatch(ctx context.Context, batch ports.Batch) (ports.WriteResult, error) {
	if len(batch.Rows) == 0 {
		return ports.WriteResult{}, nil // 수정?
	}

	path, err := url.JoinPath("/db/write", m.table)
	if err != nil {
		return ports.WriteResult{}, err
	}

	buf := bytes.Buffer{}
	if err := json.NewEncoder(&buf).Encode(batch.Rows); err != nil {
		return ports.WriteResult{}, fmt.Errorf("failed to encode json: %v", err)
	}

	query := url.Values{}
	query.Set("method", "append")

	response, err := m.cli.DoJSON(ctx, http.MethodPost, path, query, &buf)
	if err != nil {
		return ports.WriteResult{}, err
	}
	if !response.Success {
		return ports.WriteResult{}, fmt.Errorf("failed to write: %s", response.Reason)
	}

	return ports.WriteResult{}, nil
}

type machbaseAppendRequest struct {
	Columns []string `json:"columns"`
	Rows    [][]any  `json:"rows"`
}

func (m *machbaseWriter) Close(ctx context.Context) error {
	return nil
}
