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
	delay time.Duration
}

func NewTimestampStrategy(delay time.Duration) ReplicationStrategy {
	return &timestampStrategy{delay: delay}
}

func (s *timestampStrategy) ShouldReplicate(chk offset.CheckPoint, delay time.Duration) (bool, error) {
	cursor, err := chk.GetCursor()
	if err != nil {
		return false, fmt.Errorf("failed to get cursor: %v", err)
	}
	if cursor.IsZero() { // 처리
		return true, nil
	}

	until := time.Now().Add(-delay)
	return cursor.Before(until), nil
}

func (s *timestampStrategy) BuildRange(chk offset.CheckPoint, windowLimit time.Duration) (ports.Range, error) {
	cursor, err := chk.GetCursor()
	if err != nil {
		return ports.Range{}, fmt.Errorf("failed to get cursor: %v", err)
	}

	until := time.Now().Add(-s.delay)
	from := cursor
	to := from.Add(windowLimit)

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
	return nil
}

func (s *timestampStrategy) NextWindow(rng *ports.Range, windowLimit time.Duration) {

}
