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

type mode int

const (
	modeSeq mode = iota
	modeRID
)

type machbaseReader struct {
	table   string
	columns []string
	seqExpr string

	mode mode

	query       string
	metaQuery   string
	maxRIDQuery string

	ridLimit int

	cli *machbase.Client
}

// Prepare는 쿼리 템플릿만 준비
func (m *machbaseReader) Prepare(ctx context.Context) error {
	buildSelectList := func(base string) string {
		if len(m.columns) > 0 {
			return base + ", " + strings.Join(m.columns, ", ")
		}
		return base + ", *"
	}

	var selectList string
	switch strings.ToUpper(m.seqExpr) {
	case "RID":
		m.mode = modeRID

		selectList = fmt.Sprintf("/*+ RID_RANGE(%s, %%d, %%d) */ _RID", m.table)
		selectList = buildSelectList(selectList)
		m.query = fmt.Sprintf("SELECT %s FROM %s", selectList, m.table)
		m.maxRIDQuery = fmt.Sprintf("SELECT MAX(v.TABLE_END_RID) FROM M$SYS_TABLES m, V$STORAGE_TAG_TABLES v WHERE  m.ID = v.ID AND m.NAME LIKE '_%s_DATA_%%' LIMIT 1", m.table)
	default:
		m.mode = modeSeq

		selectList = fmt.Sprintf("%s AS _seq_", m.seqExpr)
		selectList = buildSelectList(selectList)
		m.query = fmt.Sprintf("SELECT %s FROM %s WHERE _seq_ >= %%s AND _seq_ < %%s ", selectList, m.table)
	}

	m.metaQuery = fmt.Sprintf("SELECT * FROM _%s_meta WHERE _ID > %%d ORDER BY _ID ASC", m.table)

	return nil
}

func (m *machbaseReader) ReadRange(ctx context.Context, rng ports.Range) (ports.Batch, error) {
	var query string
	switch m.mode {
	case modeSeq:
		query = fmt.Sprintf(m.query, tsLit(rng.From), tsLit(rng.To))
	case modeRID:
		query = fmt.Sprintf(m.query, rng.Offset, rng.Offset+m.ridLimit)
	}

	u := url.Values{}
	u.Set("q", query)

	response, err := m.cli.DoJSON(ctx, http.MethodGet, "/db/query", u, nil)
	if err != nil {
		return ports.Batch{}, err
	}
	if !response.Success {
		return ports.Batch{}, fmt.Errorf("failed to request: %v", response.Reason)
	}

	// if len(response.Data.Rows) > 0 {
	// 	lastRow := response.Data.Rows[len(response.Data.Rows)]
	// 	lastRID := lastRow[0]
	// }

	return ports.Batch{
		Columns: response.Data.Columns,
		Rows:    response.Data.Rows,
	}, nil
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

func (m *machbaseReader) Close(ctx context.Context) error {

	return nil
}

func tsLit(t time.Time) string {
	return fmt.Sprintf("TO_TIMESTAMP('%s')", t.UTC().Format(time.RFC3339Nano))
}
