package job

import (
	"errors"
	"fmt"
	"repli/internal/offset"
	"repli/internal/ports"
	"time"
)

var (
	ErrNoDataInRange = errors.New("no data in range")
)

type timestampStrategy struct {
	delay            time.Duration
	batchWindowLimit time.Duration
}

func NewTimestampStrategy(delay time.Duration, batchWindowLimit time.Duration) ReplicationStrategy {
	return &timestampStrategy{delay: delay, batchWindowLimit: batchWindowLimit}
}

func (s *timestampStrategy) ShouldReplicate(chk offset.CheckPoint) (bool, error) {
	cursor, err := chk.GetCursor()
	if err != nil {
		return false, fmt.Errorf("failed to get cursor: %v", err)
	}
	if cursor.IsZero() { // 처리
		return true, nil
	}

	until := time.Now().Add(-s.delay)
	return cursor.Before(until), nil
}

func (s *timestampStrategy) BuildRange(chk offset.CheckPoint) (ports.Range, error) {
	cursor, err := chk.GetCursor()
	if err != nil {
		return ports.Range{}, fmt.Errorf("failed to get cursor: %v", err)
	}

	// (FROM < TO) <= (NOW() - delay) < NOW()
	until := time.Now().Add(-s.delay)
	from := cursor
	to := from.Add(s.batchWindowLimit)

	if to.After(until) {
		to = until
	}

	if !from.Before(to) {
		return ports.Range{}, ErrNoDataInRange
	}

	return ports.Range{
		From: from,
		To:   to,
		RIDs: nil,
	}, nil
}

func (s *timestampStrategy) UpdateCheckPoint(chk *offset.CheckPoint, result ports.WriteResult) error {
	if result.NextCheckPointData == nil {
		return nil
	}

	if cursorStr, ok := result.NextCheckPointData["cursor"].(string); ok {
		cursor, err := time.Parse(time.RFC3339, cursorStr)
		if err != nil {
			return fmt.Errorf("invalid cursor in write result: %v", err)
		}
		return chk.SetCursor(cursor)
	}

	return nil
}

func (s *timestampStrategy) NextWindow(rng *ports.Range) {
	until := time.Now().Add(-s.delay)
	rng.From = rng.To
	rng.To = rng.From.Add(s.batchWindowLimit)
	if rng.To.After(until) {
		rng.To = until
	}
}
