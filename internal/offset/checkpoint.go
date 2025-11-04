package offset

import (
	"fmt"
	"strings"
	"time"
)

const (
	checkPointCursor = "cursor"
	checkPointRIDs   = "rids"
	// 필요 시 추가
)

// 여러 DB CheckPoint 값을 한곳에서 관리, 필요한 것만 사용 -> 나중에 포인터로 변환?
type CheckPoint struct {
	// Cursor     RFC3339Time `json:"cursor"`
	Mode   string         `json:"mode"`
	Cursor time.Time      `json:"cursor,omitempty"`
	Data   map[string]any `json:"data"`

	// 추후 제거
	MetaOffset int              `json:"meta_offset"`
	RIDs       map[string]int64 `json:"rids,omitempty"`
}

func NewCheckPoint(seqExpr string) CheckPoint {
	var chk CheckPoint

	switch strings.ToUpper(seqExpr) {
	case "RID":
		chk.Mode = "RID"
		chk.SetRIDs(make(map[string]int64))
	default:
		// case "TIMESTAMP":
		chk.Mode = "TIMESTAMP"
		chk.SetCursor(time.Now())
	}

	return chk
}

// ========================= TIMESTAMP (cursor 모드) =========================

func (c *CheckPoint) GetCursor() (time.Time, error) {
	if c.Data == nil {
		return time.Time{}, nil
	}

	if val, ok := c.Data[checkPointCursor]; ok {
		switch v := val.(type) {
		case string:
			return time.Parse(time.RFC3339, v)
		case time.Time:
			return v, nil
		}
	}

	return time.Time{}, nil
}

func (c *CheckPoint) SetCursor(cursor time.Time) error {
	if c.Data == nil {
		c.Data = make(map[string]any)
	}
	if cursor.IsZero() {
		return fmt.Errorf("cursor is zero")
	}

	c.Data[checkPointCursor] = cursor
	return nil
}

// ========================= RIDs (RID 모드) =========================

func (c *CheckPoint) GetRIDs() map[string]int64 {
	if c.Data == nil {
		return make(map[string]int64)
	}

	if v, ok := c.Data[checkPointRIDs].(map[string]any); ok {
		result := make(map[string]int64)
		for k, val := range v {
			switch num := val.(type) {
			case float64:
				result[k] = int64(num)
			case int64:
				result[k] = num
			case int:
				result[k] = int64(num)
			}
		}
		return result
	}

	if v, ok := c.Data[checkPointRIDs].(map[string]int64); ok {
		return v
	}

	return make(map[string]int64)
}

func (c *CheckPoint) SetRIDs(rids map[string]int64) {
	if c.Data == nil {
		c.Data = make(map[string]any)
	}

	c.Data[checkPointRIDs] = rids
}
