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

// baseSQL := fmt.Sprintf("select v.ID, m.NAME, v.TABLE_END_RID from V$STORAGE_TAG_TABLES v, M$SYS_TABLES m WHERE v.ID = m.ID AND m.NAME LIKE '_%s_DATA_%%'", table)
func (c *Client) LookupEndRIDS(ctx context.Context, table string) ([]RIDStore, error) {
	baseSQL := fmt.Sprintf("SELECT m.NAME AS name, v.TABLE_END_RID AS rid FROM V$STORAGE_TAG_TABLES v, M$SYS_TABLES m WHERE v.ID = m.ID AND m.NAME LIKE '_%s_DATA_%%'", table)

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

func (c *Client) LookupDataColumns(ctx context.Context, table string) ([]any, error) {
	baseSQL := fmt.Sprintf("SELECT c.NAME AS NAME FROM M$SYS_TABLES t, M$SYS_COLUMNS c WHERE c.TABLE_ID = t.ID AND t.NAME = '_%s_DATA_0' AND c.ID > 0 AND c.ID < 65534 ORDER BY c.ID ASC", strings.ToUpper(table))
	log.Printf("baseSQL: %s", baseSQL)

	query := url.Values{}
	query.Set("q", baseSQL)

	response, err := c.DoANY(ctx, http.MethodGet, "/db/query", query, nil)
	if err != nil {
		return nil, err
	}
	if !response.Success {
		return nil, err
	}

	dataColumns := []string{}
	if len(response.Data.Rows) > 0 {
		for _, row := range response.Data.Rows {
			for _, r := range row {
				r.(string)
				dataColumns = append(dataColumns, r)
			}
		}
	}

	return response.Data.Rows, nil
}

func (c *Client) LookupMetaColumns(ctx context.Context, table string) ([]string, error) {
	baseSQL := fmt.Sprintf("select c.NAME from M$SYS_TABLES t, M$SYS_COLUMNS c WHERE c.TABLE_ID = t.ID AND t.NAME = '_%s_META' AND c.ID > 1 AND c.ID <65534  order by c.ID asc", table)

	query := url.Values{}
	query.Set("q", baseSQL)

	response, err := c.DoJSON(ctx, http.MethodGet, "/db/query", query, nil)
	if err != nil {
		return nil, err
	}
	if !response.Success {
		return nil, err
	}

	metaColumns := []string{}
	if err := json.Unmarshal(response.Data.Rows, &metaColumns); err != nil {
		return nil, err
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
