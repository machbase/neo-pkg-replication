package machbase

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"strings"
)

type HTTPDoer interface {
	Do(*http.Request) (*http.Response, error)
}

type Client struct {
	base *url.URL
	hc   HTTPDoer
}

func NewClient(baseURL string, hc HTTPDoer) (*Client, error) {
	u, err := url.Parse(baseURL)
	if err != nil {
		return nil, err
	}
	if hc == nil {
		hc = &http.Client{}
	}
	return &Client{base: u, hc: hc}, nil
}

const ErrTableNotExists = "MACH-ERR 2025"

func (c *Client) TableExists(ctx context.Context, table string) (bool, error) {
	query := url.Values{}
	query.Set("q", fmt.Sprintf("SELECT * FROM %s LIMIT 1", table))

	response, err := c.DoJSON(ctx, http.MethodGet, "/db/query", query, nil)
	if err != nil {
		return false, err
	}

	if response.Success {
		return true, nil
	} else if !response.Success && strings.HasPrefix(response.Reason, ErrTableNotExists) {
		return false, nil
	}

	return false, fmt.Errorf("%q table is not exists: %v", table, response.Reason)
}

type RIDStore struct {
	Name string `json:"name"`
	RID  int    `json:"rid"`
}

// TagIDName represents a mapping between tag ID and tag name
type TagIDName struct {
	ID   int64  `json:"ID"`
	Name string `json:"NAME"`
}

// baseSQL := fmt.Sprintf("select v.ID, m.NAME, v.TABLE_END_RID from V$STORAGE_TAG_TABLES v, M$SYS_TABLES m WHERE v.ID = m.ID AND m.NAME LIKE '_%s_DATA_%%'", table)
func (c *Client) LookupLastRIDS(ctx context.Context, table string) ([]RIDStore, error) {
	baseSQL := fmt.Sprintf("SELECT m.NAME AS name, v.TABLE_END_RID AS rid FROM V$STORAGE_TAG_TABLES v, M$SYS_TABLES m WHERE v.ID = m.ID AND m.NAME LIKE '_%s_DATA_%%'", table)
	log.Printf("last rid query: %v\n", baseSQL)

	query := url.Values{}
	query.Set("q", baseSQL)
	query.Set("rowsArray", "true")

	response, err := c.DoJSON(ctx, http.MethodGet, "/db/query", query, nil)
	if err != nil {
		return nil, err
	}
	if !response.Success {
		return nil, err
	}

	stores := []RIDStore{}
	if err := json.Unmarshal(response.Data.Rows, &stores); err != nil {
		return nil, err
	}

	if len(stores) == 0 {
		return nil, fmt.Errorf("rid store length is 0")
	}

	return stores, nil
}

// select c.NAME,c.ID from M$SYS_TABLES t, M$SYS_COLUMNS c WHERE c.TABLE_ID = t.ID AND t.NAME = '_EVENT_DATA_0' AND c.ID > 0 AND c.ID <65534  order by c.ID asc;
// select c.NAME,c.ID from M$SYS_TABLES t, M$SYS_COLUMNS c WHERE c.TABLE_ID = t.ID AND t.NAME = '_EVENT_META' AND c.ID > 1 AND c.ID <65534  order by c.ID asc;

func (c *Client) LookupDataColumns(ctx context.Context, table string) ([]string, error) {
	baseSQL := fmt.Sprintf("SELECT c.NAME FROM M$SYS_TABLES t, M$SYS_COLUMNS c WHERE c.TABLE_ID = t.ID AND t.NAME = '_%s_DATA_0' AND c.ID > 0 AND c.ID < 65534 ORDER BY c.ID ASC", strings.ToUpper(table))

	query := url.Values{}
	query.Set("q", baseSQL)
	query.Set("rowsArray", "true")

	response, err := c.DoJSON(ctx, http.MethodGet, "/db/query", query, nil)
	if err != nil {
		return nil, err
	}
	if !response.Success {
		return nil, err
	}

	v := []struct {
		Name string `json:"NAME"`
	}{}

	err = json.Unmarshal(response.Data.Rows, &v)
	if err != nil {
		return nil, err
	}

	columns := make([]string, 0, len(v))
	for _, col := range v {
		columns = append(columns, col.Name)
	}

	return columns, nil
}

// LookupTagIDNames retrieves tag ID to name mappings from the meta table
// It returns a map where keys are tag IDs and values are tag names
func (c *Client) LookupTagIDNames(ctx context.Context, column string, table string) (map[int64]string, error) {
	baseSQL := fmt.Sprintf("SELECT _ID AS ID, %s AS NAME FROM _%s_META", column, table)

	query := url.Values{}
	query.Set("q", baseSQL)
	query.Set("rowsArray", "true")

	response, err := c.DoJSON(ctx, http.MethodGet, "/db/query", query, nil)
	if err != nil {
		return nil, err
	}
	if !response.Success {
		return nil, err
	}

	var tagIDNames []TagIDName
	err = json.Unmarshal(response.Data.Rows, &tagIDNames)
	if err != nil {
		return nil, err
	}

	idToName := make(map[int64]string, len(tagIDNames))
	for _, tag := range tagIDNames {
		idToName[tag.ID] = tag.Name
	}

	return idToName, nil
}

// select _ID, SENSOR_ID from _WAREHOUSE_SENSORS_meta;
// baseSQL := fmt.Sprintf("SELECT _ID, SENSOR_ID FROM _WAREHOUSE_SENSORS_META", )

func (c *Client) LookupTagNameColumn(ctx context.Context, table string) (string, error) {
	baseSQL := fmt.Sprintf("SELECT C.NAME AS NAME FROM M$SYS_TABLES T, M$SYS_COLUMNS C WHERE T.NAME = '%s' AND C.TABLE_ID = T.ID AND C.ID = 0", table)

	query := url.Values{}
	query.Set("q", baseSQL)
	query.Set("rowsArray", "true")

	response, err := c.DoJSON(ctx, http.MethodGet, "/db/query", query, nil)
	if err != nil {
		return "", err
	}
	if !response.Success {
		return "", err
	}

	v := []struct {
		Name string `json:"NAME"`
	}{}

	err = json.Unmarshal(response.Data.Rows, &v)
	if err != nil {
		return "", err
	}

	return v[0].Name, nil
}

func (c *Client) LookupMetaColumns(ctx context.Context, table string) ([]string, error) {
	baseSQL := fmt.Sprintf("SELECT c.NAME FROM M$SYS_TABLES t, M$SYS_COLUMNS c WHERE c.TABLE_ID = t.ID AND t.NAME = '_%s_META' AND c.ID > 1 AND c.ID < 65534  ORDER BY c.ID ASC", strings.ToUpper(table))
	log.Println("query: ", baseSQL)

	query := url.Values{}
	query.Set("q", baseSQL)
	query.Set("rowsArray", "true")

	response, err := c.DoJSON(ctx, http.MethodGet, "/db/query", query, nil)
	if err != nil {
		return nil, err
	}
	if !response.Success {
		return nil, err
	}

	v := []struct {
		Name string `json:"NAME"`
	}{}

	err = json.Unmarshal(response.Data.Rows, &v)
	if err != nil {
		return nil, err
	}

	metaColumns := make([]string, 0, len(v))
	for _, col := range v {
		metaColumns = append(metaColumns, col.Name)
	}

	return metaColumns, nil
}

// 마크베이스 url path는 고정이라 매개변수로 안 받아도 될듯? path = /db/query
func (c *Client) DoJSON(ctx context.Context, method, path string, q url.Values, body io.Reader) (*ResponseJSON, error) {
	u := c.base.ResolveReference(&url.URL{Path: path})

	if len(q) > 0 {
		u.RawQuery = q.Encode()
	}

	req, err := http.NewRequestWithContext(ctx, method, u.String(), body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")

	if body != nil && req.Header.Get("Content-Type") == "" {
		req.Header.Set("Content-Type", "application/json")
	}

	rsp, err := c.hc.Do(req)
	if err != nil {
		return nil, err
	}
	defer rsp.Body.Close()

	decoder := json.NewDecoder(rsp.Body)
	var resp ResponseJSON
	if err := decoder.Decode(&resp); err != nil {
		return nil, fmt.Errorf("failed to decode json: %v", err)
	}
	if !resp.Success {
		return nil, fmt.Errorf("machbase request failed: %s", resp.Reason)
	}

	return &resp, nil
}

// 마크베이스 url path는 고정이라 매개변수로 안 받아도 될듯? path = /db/query
func (c *Client) DoANY(ctx context.Context, method, path string, q url.Values, body io.Reader) (*Response, error) {
	u := c.base.ResolveReference(&url.URL{Path: path})

	if len(q) > 0 {
		u.RawQuery = q.Encode()
	}

	req, err := http.NewRequestWithContext(ctx, method, u.String(), body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")

	if body != nil && req.Header.Get("Content-Type") == "" {
		req.Header.Set("Content-Type", "application/json")
	}

	rsp, err := c.hc.Do(req)
	if err != nil {
		return nil, err
	}
	defer rsp.Body.Close()

	decoder := json.NewDecoder(rsp.Body)
	var resp Response
	if err := decoder.Decode(&resp); err != nil {
		return nil, fmt.Errorf("failed to decode json: %v", err)
	}
	if !resp.Success {
		return nil, fmt.Errorf("machbase request failed: %s", resp.Reason)
	}

	return &resp, nil
}

type Response struct {
	Success bool   `json:"success"`
	Reason  string `json:"reason"`
	Elapse  string `json:"elapse"`
	Data    struct {
		Columns []string `json:"columns"`
		Rows    [][]any  `json:"rows"`
	} `json:"data,omitempty"`
}

type ResponseJSON struct {
	Success bool   `json:"success"`
	Reason  string `json:"reason"`
	Elapse  string `json:"elapse"`
	Data    struct {
		Columns []string        `json:"columns"`
		Rows    json.RawMessage `json:"rows"`
	} `json:"data,omitempty"`
}

type Table struct {
	Columns []string `json:"columns"`
	Type    []string `json:"type"`
	Rows    [][]any  `json:"rows"`
}
