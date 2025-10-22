package target

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"repli/internal/machbase"
	"repli/internal/ports"
)

type machbaseWriter struct {
	table     string
	metaTable string
	columns   []string
	seqExpr   string
	affix     string
	placement string

	cli *machbase.Client
}

func (m *machbaseWriter) Prepare(ctx context.Context) error {
	m.metaTable = fmt.Sprintf("_%s_meta", m.table)

	return nil
}

func (m *machbaseWriter) WriteBatch(ctx context.Context, batch ports.Batch) (ports.WriteResult, error) {
	if len(batch.Rows) == 0 {
		return ports.WriteResult{}, nil // 수정?
	}

	path, err := url.JoinPath("/db/write", m.table)
	if err != nil {
		return ports.WriteResult{}, err
	}

	metaColumns, ok := batch.Meta["metaColumns"]
	if !ok {

	}
	meta, ok := metaColumns.([]string)
	if !ok {

	}

	metaAppend := make([]any, 0, len(meta))
	for range meta {
		metaAppend = append(metaAppend, "")
	}

	// placement : nonce  				====> DoANY
	// placement : prefix, suffsic      ====> DoJSON

	payload := make([][]any, len(batch.Rows))
	for i, rows := range batch.Rows {
		payload[i] = make([]any, len(rows))
		rows = append(rows, metaAppend...)
		// m.AppendAffix(rows[0])
		payload[i] = rows
	}
	for _, row := range payload {
		log.Printf("row: %v, %d", row, len(row))
	}
	batch.Rows = payload

	// 아래 수정 필요

	buf := bytes.Buffer{}
	if err := json.NewEncoder(&buf).Encode(batch.Rows); err != nil {
		return ports.WriteResult{}, fmt.Errorf("failed to encode json: %v", err)
	}

	query := url.Values{}
	query.Set("method", "append")

	response, err := m.cli.DoANY(ctx, http.MethodPost, path, query, &buf)
	if err != nil {
		return ports.WriteResult{}, err
	}
	if !response.Success {
		return ports.WriteResult{}, fmt.Errorf("failed to write: %s", response.Reason)
	}

	return ports.WriteResult{}, nil
}

func (m *machbaseWriter) WriteMeta(ctx context.Context, batch ports.Batch) (ports.WriteResult, error) {
	if len(batch.Rows) == 0 {
		return ports.WriteResult{}, nil // 수정?
	}

	// insert into _event_meta metadata values ('TAG_0002', 99, '2010-01-01', '1.1.1.1');

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

func (m *machbaseWriter) AppendAffix(s string) string {
	switch m.placement {
	case "prefix":
		return m.affix + "." + s
	case "suffix":
		return s + "." + m.affix
	case "regexp":
	case "none":
		return s
	default:
		return s
	}
	return ""
}
