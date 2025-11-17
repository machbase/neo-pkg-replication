package source

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"repli/internal/machbase"
	"repli/internal/ports"
	"strings"
	"time"
)

type mode int
type readRangeFn func(ctx context.Context, rng ports.Range) (ports.Batch, error)

const (
	modeSeq mode = iota
	modeRID
)

type machbaseReader struct {
	table   string
	columns []string
	seqExpr string

	mode mode

	ridLimit int64

	queryFmt  string
	metaFmt   string
	maxRIDFmt string

	readFn readRangeFn

	cli *machbase.Client
}

// Prepare는 쿼리 템플릿만 준비
func (m *machbaseReader) Prepare(ctx context.Context) error {
	dataColumns, err := m.cli.LookupDataColumns(ctx, m.table)
	if err != nil {
		return err
	}
	metaColumns, err := m.cli.LookupMetaColumns(ctx, m.table)
	if err != nil {
		return err
	}

	// 수정 필요
	buildSelectList := func(base string) string {
		columns := make([]string, 0, len(m.columns))
		if len(m.columns) > 0 {
			for _, col := range m.columns {
				columns = append(columns, "d."+col)
			}
			return base + ", " + strings.Join(columns, ", ")
		} else {
			for i, col := range dataColumns {
				if i == 0 {
					columns = append(columns, "m."+col)
				} else {
					columns = append(columns, "d."+col)
				}
			}
			return base + ", " + strings.Join(columns, ", ")
		}
	}
	m.metaFmt = fmt.Sprintf("SELECT * FROM _%s_meta WHERE _ID > 0 ORDER BY _ID ASC", m.table)

	switch strings.ToUpper(m.seqExpr) {
	case "RID":
		m.mode = modeRID
		// m.maxRIDFmt = fmt.Sprintf("SELECT MAX(v.TABLE_END_RID) FROM M$SYS_TABLES m, V$STORAGE_TAG_TABLES v WHERE  m.ID = v.ID AND m.NAME LIKE '_%s_DATA_%%' LIMIT 1", m.table)

		ridStore, err := m.cli.LookupEndRIDS(ctx, m.table)
		if err != nil {
			return nil
		}

		m.queryFmt = fmt.Sprintf("SELECT %%s FROM %%s d, _%s_meta m WHERE  d.name = m._ID LIMIT 1", m.table)
		m.readFn = func(ctx context.Context, rng ports.Range) (ports.Batch, error) {
			var (
				cols []string
				rows [][]any
			)

			for _, store := range ridStore {
				rid, ok := rng.RIDs[store.Name]
				if !ok {
					rng.RIDs[store.Name] = 0
					rid = 0
				}

				base := fmt.Sprintf("/*+ RID_RANGE(%s, %d, %d) */ d._RID", store.Name, rid, (rid+1)+m.ridLimit)
				selectList := buildSelectList(base)
				query := fmt.Sprintf(m.queryFmt, selectList, store.Name)
				log.Printf("query: %s", query)

				b, err := m.execQuery(ctx, query)
				if err != nil {
					return ports.Batch{}, err
				}
				b.Columns = b.Columns[1:]

				// b.Columns = append(b.Columns[0:3], b.Columns[4:]...)
				// i := 3
				// if i >= 0 && i < len(b.Columns) {
				// 	copy(b.Columns[i:], b.Columns[i+1:]) // 뒤를 한 칸 당김
				// 	// 마지막 칸 비워서 참조 끊기 (GC 위해)
				// 	b.Columns[len(b.Columns)-1] = ""
				// 	b.Columns = b.Columns[:len(b.Columns)-1]
				// }

				if cols == nil {
					cols = b.Columns
					cols = append(cols, metaColumns...)
				}

				for i := 0; i < len(b.Rows); i++ {
					b.Rows[i] = b.Rows[i][1:]
				}

				if len(b.Rows) > 0 {
					rows = append(rows, b.Rows...)
				}
			}

			return ports.Batch{
				Columns: cols,
				Rows:    rows,
			}, nil
		}
	default:
		m.mode = modeSeq

		m.queryFmt = fmt.Sprintf("SELECT %%s FROM %s WHERE _seq_ >= %%s AND _seq_ < %%s", m.table)
		m.readFn = func(ctx context.Context, rng ports.Range) (ports.Batch, error) {
			base := fmt.Sprintf("%s AS _seq_", m.seqExpr)
			selectList := buildSelectList(base)
			query := fmt.Sprintf(m.queryFmt, selectList)

			return m.execQuery(ctx, query)
		}
	}

	return nil
}

func (m *machbaseReader) execQuery(ctx context.Context, query string) (ports.Batch, error) {
	u := url.Values{}
	u.Set("q", query)

	response, err := m.cli.DoANY(ctx, http.MethodGet, "/db/query", u, nil)
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
	return m.readFn(ctx, rng)
}

func (m *machbaseReader) ReadMeta(ctx context.Context, offset int) (ports.Batch, error) {
	metaQuery := fmt.Sprintf(m.metaFmt, offset)

	u := url.Values{}
	u.Set("q", metaQuery)

	response, err := m.cli.DoANY(ctx, http.MethodGet, "/db/query", u, nil)
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
