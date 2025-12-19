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

	// RID mode specific fields
	lastRIDStore []machbase.RIDStore
	metaColumns  []string

	idToName map[int64]string

	cli *machbase.Client
}

// Prepare는 쿼리 템플릿만 준비
func (m *machbaseReader) Prepare(ctx context.Context) error {
	// dataColumns, err := m.cli.LookupDataColumns(ctx, m.table)
	// if err != nil {
	// 	return err
	// }
	metaColumns, err := m.cli.LookupMetaColumns(ctx, m.table)
	if err != nil {
		return err
	}

	// meta query
	m.metaFmt = fmt.Sprintf("SELECT * FROM _%s_meta WHERE _ID > %%d ORDER BY _ID ASC", m.table)

	switch strings.ToUpper(m.seqExpr) {
	case "RID":
		m.mode = modeRID

		// Lookup RID stores
		ridStore, err := m.cli.LookupLastRIDS(ctx, m.table)
		if err != nil {
			return fmt.Errorf("failed to lookup RID stores: %v", err)
		}
		if len(ridStore) == 0 {
			return fmt.Errorf("no RID stores found for table %s", m.table)
		}
		log.Printf("ridStore: %v", ridStore)

		tagNameColumn, err := m.cli.LookupTagNameColumn(ctx, m.table)
		if err != nil {
			return fmt.Errorf("failed to lookup tagname column: %v", err)
		}
		log.Printf("tagNameColumn: %v", tagNameColumn)

		// Lookup tag ID to name mappings
		idToName, err := m.cli.LookupTagIDNames(ctx, tagNameColumn, m.table)
		if err != nil {
			return fmt.Errorf("failed to lookup tag ID to name mappings: %v", err)
		}
		m.idToName = idToName
		log.Printf("tag ID to name mappings: %v", idToName)

		// Store fields for readRangeRID method
		m.lastRIDStore = ridStore
		m.metaColumns = metaColumns
		m.queryFmt = fmt.Sprintf("SELECT %%s FROM %%s")
	default:
		m.mode = modeSeq
		m.queryFmt = fmt.Sprintf("SELECT %%s FROM %s WHERE _seq_ >= %%s AND _seq_ < %%s", m.table)
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
	switch m.mode {
	case modeRID:
		return m.readRangeRID(ctx, rng)
	case modeSeq:
		return m.readRangeSeq(ctx, rng)
	default:
		return ports.Batch{}, fmt.Errorf("unknown mode: %v", m.mode)
	}
}

func (m *machbaseReader) readRangeRID(ctx context.Context, rng ports.Range) (ports.Batch, error) {
	// Helper function to build SELECT list
	buildSelectList := func(ridColumn string) string {
		if len(m.columns) > 0 {
			return ridColumn + ", " + strings.Join(m.columns, ", ")
		} else {
			dataColumns, _ := m.cli.LookupDataColumns(ctx, m.table)
			return ridColumn + ", " + strings.Join(dataColumns, ", ")
		}
	}

	var (
		cols     []string
		rows     [][]any
		nextRIDs = make(map[string]int64)
	)

	/* lastRIDStore : [
		{_WAREHOUSE_SENSORS_DATA_0 1584}
		{_WAREHOUSE_SENSORS_DATA_1 1584}
		{_WAREHOUSE_SENSORS_DATA_2 1584}
		{_WAREHOUSE_SENSORS_DATA_3 0}
	] */

	for _, store := range m.lastRIDStore {
		rid, ok := rng.RIDs[store.Name]
		if !ok {
			rid = 0
		}

		// Skip if current RID has reached or exceeded the max RID for this store
		if rid >= int64(store.RID) {
			log.Printf("[%s] skipping: current RID %d >= max RID %d", store.Name, rid, store.RID)
			nextRIDs[store.Name] = rid // Keep current RID
			continue
		}

		ridColumnWithHint := fmt.Sprintf("/*+ RID_RANGE(%s, %d, %d) */ _RID", store.Name, rid, rid+m.ridLimit)
		selectColumns := buildSelectList(ridColumnWithHint)
		query := fmt.Sprintf(m.queryFmt, selectColumns, store.Name)

		log.Printf("query: %s", query)
		// SELECT /*+ RID_RANGE(_WAREHOUSE_SENSORS_DATA_2, 0, 1000) */ _RID, SENSOR_ID, TIME, TEMPERATURE, HUMIDITY FROM _WAREHOUSE_SENSORS_DATA_2

		b, err := m.execQuery(ctx, query)
		if err != nil {
			return ports.Batch{}, err
		}
		b.Columns = b.Columns[1:] // Remove _RID column

		if cols == nil {
			cols = b.Columns
		}

		// Extract RID from each row and track the last one
		var lastRID int64
		for i := 0; i < len(b.Rows); i++ {
			log.Println("b.rows[i]: ", b.Rows[i])
			if ridVal, ok := b.Rows[i][0].(int64); ok {
				lastRID = ridVal
			} else if ridVal, ok := b.Rows[i][0].(float64); ok {
				lastRID = int64(ridVal)
			}
			b.Rows[i] = b.Rows[i][1:] // Remove RID from row

			// Convert tag ID to tag name using idToName mapping
			if len(b.Rows[i]) > 0 && m.idToName != nil {
				// The first column after removing _RID is the tag ID column
				if tagID, ok := b.Rows[i][0].(int64); ok {
					if tagName, exists := m.idToName[tagID]; exists {
						b.Rows[i][0] = tagName
						log.Printf("Converted tag ID %d to name '%s'", tagID, tagName)
					}
				} else if tagID, ok := b.Rows[i][0].(float64); ok {
					if tagName, exists := m.idToName[int64(tagID)]; exists {
						b.Rows[i][0] = tagName
						log.Printf("Converted tag ID %d to name '%s'", int64(tagID), tagName)
					}
				}
			}
		}

		// Update next RID for this store
		if len(b.Rows) > 0 {
			nextRIDs[store.Name] = lastRID + 1
			rows = append(rows, b.Rows...)
			log.Printf("[%s] read %d rows, lastRID=%d, nextRID=%d", store.Name, len(b.Rows), lastRID, lastRID+1)
		} else {
			nextRIDs[store.Name] = rid // Keep current if no new data
			log.Printf("[%s] no data, keeping rid=%d", store.Name, rid)
		}
	}

	return ports.Batch{
		Columns: cols,
		Rows:    rows,
		Meta: map[string]any{
			"rids":        nextRIDs,
			"metaColumns": m.metaColumns,
		},
	}, nil
}

func (m *machbaseReader) readRangeSeq(ctx context.Context, rng ports.Range) (ports.Batch, error) {
	// Helper function to build SELECT list
	buildSelectList := func(seqColumn string) string {
		columns := make([]string, 0, len(m.columns))
		if len(m.columns) > 0 {
			for _, col := range m.columns {
				columns = append(columns, "d."+col)
			}
			return seqColumn + ", " + strings.Join(columns, ", ")
		} else {
			dataColumns, _ := m.cli.LookupDataColumns(ctx, m.table)
			for i, col := range dataColumns {
				if i == 0 {
					columns = append(columns, "m."+col)
				} else {
					columns = append(columns, "d."+col)
				}
			}
			return seqColumn + ", " + strings.Join(columns, ", ")
		}
	}

	seqColumnAlias := fmt.Sprintf("%s AS _seq_", m.seqExpr)
	selectColumns := buildSelectList(seqColumnAlias)
	query := fmt.Sprintf(m.queryFmt, selectColumns)

	return m.execQuery(ctx, query)
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
