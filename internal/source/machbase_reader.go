package source

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"repli/internal/machbase"
	"repli/internal/ports"
	"strings"
	"time"
)

type machbaseReader struct {
	table   string
	columns []string
	seqExpr string

	useMeta    bool
	metaQuery  string
	metaOffset int

	query string

	cli *machbase.Client
}

func (m *machbaseReader) Prepare(ctx context.Context) error {
	var selectCols string
	switch strings.ToUpper(m.seqExpr) {
	case "_RID":
		selectCols = fmt.Sprintf("/*+ RID_RANGE(%s, %%s, %%s) */ _RID", m.table)
	default:
		selectCols = fmt.Sprintf("%s AS _seq_", m.seqExpr)
	}

	if len(m.columns) > 0 {
		selectCols += ", " + strings.Join(m.columns, ",")
	} else {
		selectCols += ", " + "*"
	}
	// 수정 필요

	m.query = fmt.Sprintf("SELECT %s FROM %s WHERE _seq_ >= %%s AND _seq_ < %%s", selectCols, m.table)
	m.metaQuery = fmt.Sprintf("SELECT * FROM _%s_meta WHERE _ID > %%d ORDER BY _ID ASC", m.table)

	return nil
}

func (m *machbaseReader) ReadMeta(ctx context.Context, offset int) (ports.Batch, error) {
	metaQuery := fmt.Sprintf(m.metaQuery, offset)
	u := url.Values{}
	u.Set("q", metaQuery)

	response, err := m.cli.DoJSON(ctx, http.MethodGet, "/db/query", u, nil)
	if err != nil {
		return ports.Batch{}, err
	}
	if !response.Success {
		return ports.Batch{}, fmt.Errorf("failed to request: %v", response.Reason)
	}

	return ports.Batch{
		Columns: response.Data.Columns,
		Rows:    response.Data.Rows,
	}, nil

}

func (m *machbaseReader) ReadRange(ctx context.Context, rng ports.Range) (ports.Batch, error) {
	if m.useMeta {
	}

	query := fmt.Sprintf(m.query, tsLit(rng.From), tsLit(rng.To))

	u := url.Values{}
	u.Set("q", query)

	response, err := m.cli.DoJSON(ctx, http.MethodGet, "/db/query", u, nil)
	if err != nil {
		return ports.Batch{}, err
	}
	if !response.Success {
		return ports.Batch{}, fmt.Errorf("failed to request: %v", response.Reason)
	}

	return ports.Batch{
		Columns: response.Data.Columns,
		Rows:    response.Data.Rows,
	}, nil
}

func (m *machbaseReader) Close(ctx context.Context) error {

	return nil
}

func tsLit(t time.Time) string {
	return fmt.Sprintf("TO_TIMESTAMP('%s')", t.UTC().Format(time.RFC3339Nano))
}
