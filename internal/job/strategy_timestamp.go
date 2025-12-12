package job

import (
	"context"
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

// Execute implements the complete replication cycle for TIMESTAMP mode
func (s *timestampStrategy) Execute(ctx context.Context, chk offset.CheckPoint, reader ports.SourceReader, writer ports.TargetWriter) (offset.CheckPoint, error) {
	// Check if replication is needed
	should, err := s.shouldReplicate(chk)
	if err != nil || !should {
		return chk, err
	}

	cursor, err := chk.GetCursor()
	if err != nil {
		return chk, fmt.Errorf("failed to get cursor: %v", err)
	}

	until := time.Now().Add(-s.delay)

	// TIMESTAMP mode: time-window based loop
	for cursor.Before(until) {
		// Build range for this window
		from := cursor
		to := from.Add(s.batchWindowLimit)
		if to.After(until) {
			to = until
		}

		if !from.Before(to) {
			break
		}

		// Read batch
		batch, err := reader.ReadRange(ctx, ports.Range{From: from, To: to})
		if err != nil {
			return chk, fmt.Errorf("failed to read range: %v", err)
		}

		// Write batch
		result, err := writer.WriteBatch(ctx, batch)
		if err != nil {
			return chk, fmt.Errorf("failed to write batch: %v", err)
		}

		// Update checkpoint
		if err := s.updateCheckPoint(&chk, result, to); err != nil {
			return chk, err
		}

		cursor = to
	}

	return chk, nil
}

// Private helper methods

func (s *timestampStrategy) shouldReplicate(chk offset.CheckPoint) (bool, error) {
	cursor, err := chk.GetCursor()
	if err != nil {
		return false, fmt.Errorf("failed to get cursor: %v", err)
	}
	if cursor.IsZero() {
		return true, nil
	}

	until := time.Now().Add(-s.delay)
	return cursor.Before(until), nil
}

func (s *timestampStrategy) updateCheckPoint(chk *offset.CheckPoint, result ports.WriteResult, nextCursor time.Time) error {
	// Use result data if provided
	if result.NextCheckPointData != nil {
		if cursorStr, ok := result.NextCheckPointData["cursor"].(string); ok {
			cursor, err := time.Parse(time.RFC3339, cursorStr)
			if err != nil {
				return fmt.Errorf("invalid cursor in write result: %v", err)
			}
			return chk.SetCursor(cursor)
		}
	}

	// Otherwise use the window's end time
	return chk.SetCursor(nextCursor)
}
