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
	"strings"
)

type machbaseWriter struct {
	table   string
	columns []string
	seqExpr string
	query   string

	limit int

	cli *machbase.Client
}

func (m *machbaseWriter) Prepare(ctx context.Context) error {
	if len(m.columns) == 0 {
		return fmt.Errorf("machbase writer ")
	}

	insertCols := strings.Join(m.columns, ",")
	insertVals := strings.Repeat("%%s", len(m.columns))

	m.query = fmt.Sprintf("INSERT INTO %s(%s) VALUES(%s)", m.table, insertCols, insertVals)

	return nil
}

func (m *machbaseWriter) WriteBatch(ctx context.Context, batch ports.Batch) (ports.WriteResult, error) {
	path, err := url.JoinPath("/db/write", m.table)
	if err != nil {
		return ports.WriteResult{}, err
	}

	if len(batch.Rows) == 0 {
		return ports.WriteResult{}, fmt.Errorf("")
	}

	rangeCnt := len(batch.Rows) / m.limit
	if rangeCnt == 0 {
		rangeCnt = 1
	}
	if len(batch.Rows)%m.limit > 0 {
		rangeCnt += 1
	}

	startLimit := 0
	endLimit := m.limit
	for i := 0; i < rangeCnt; i++ {
		// rangeCnt 와 endLimit 확인 필요
		if endLimit > len(batch.Rows) && startLimit < len(batch.Rows) {
			endLimit = len(batch.Rows)
		}
		rows := batch.Rows[startLimit:endLimit]
		startLimit += m.limit
		endLimit += m.limit

		bdata, err := json.Marshal(rows)
		if err != nil {
			return ports.WriteResult{}, fmt.Errorf("failed to marshal json: %v", err)
		}

		response, err := m.cli.DoJSON(ctx, http.MethodPost, path, nil, bytes.NewReader(bdata))
		if err != nil {
			return ports.WriteResult{}, err
		}

		if !response.Success {
			return ports.WriteResult{}, fmt.Errorf("failed to write: %s", response.Reason)
		}
	}

	// limit 을 기준으로 batch.Rows를 나눠서 전송

	return ports.WriteResult{}, nil
}

func (m *machbaseWriter) Close(ctx context.Context) error {
	return nil
}

type Reader struct {
	buf []byte
}

func NewReader(bdata []byte) Reader {
	return Reader{buf: make([]byte, 0, len(bdata))}
}

func (r *Reader) Read() ([]byte, error) {

	return r.buf[:], nil
}
