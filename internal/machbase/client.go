package machbase

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
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

func (c *Client) DoJSON(ctx context.Context, method, path string, q url.Values, body io.Reader) (*Response, error) {
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
	// if rsp.StatusCode/100 != 2 {
	// 	return nil, fmt.Errorf("http request failed: status=%d, reason=%q", rsp.StatusCode, resp.Reason)
	// }

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

type Table struct {
	Columns []string `json:"columns"`
	Type    []string `json:"type"`
	Rows    [][]any  `json:"rows"`
}
