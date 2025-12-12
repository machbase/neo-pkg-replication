package job

import (
	"context"
	"fmt"
	"repli/internal/offset"
	"repli/internal/ports"
	"time"
)

type ridStrategy struct {
	ridLimit int64
}

func NewRIDStrategy(ridLimit int64) ReplicationStrategy {
	return &ridStrategy{ridLimit: ridLimit}
}

// Execute implements the complete replication cycle for RID mode
func (s *ridStrategy) Execute(ctx context.Context, chk offset.CheckPoint, reader ports.SourceReader, writer ports.TargetWriter) (offset.CheckPoint, error) {
	// Check if replication is needed
	should, err := s.shouldReplicate(chk)
	if err != nil || !should {
		return chk, err
	}

	// RID mode: LIMIT-based loop
	for {
		rids := chk.GetRIDs()
		if rids == nil {
			rids = make(map[string]int64)
		}

		// Read batch with RID-based range
		batch, err := reader.ReadRange(ctx, ports.Range{
			From: time.Time{},
			To:   time.Time{},
			RIDs: rids,
		})
		if err != nil {
			return chk, fmt.Errorf("failed to read range: %v", err)
		}

		// RID mode: stop if no data
		if len(batch.Rows) == 0 {
			break
		}

		// Write batch
		result, err := writer.WriteBatch(ctx, batch)
		if err != nil {
			return chk, fmt.Errorf("failed to write batch: %v", err)
		}

		// Update checkpoint with new RIDs
		if err := s.updateCheckPoint(&chk, result); err != nil {
			return chk, err
		}

		// If nothing was written, stop to avoid infinite loop
		if result.Written == 0 {
			break
		}
	}

	return chk, nil
}

// Private helper methods

func (s *ridStrategy) shouldReplicate(chk offset.CheckPoint) (bool, error) {
	// Always replicate in RID mode
	// Empty RIDs map means first run, should start replication
	return true, nil
}

// 프로그램 최초 실행, 숫자는 Unmarshal 시 float64
// 프로그램 실행 중,   메모리에서는 int64
func (s *ridStrategy) updateCheckPoint(chk *offset.CheckPoint, result ports.WriteResult) error {
	if result.Written > 0 {
		if result.NextCheckPointData == nil {
			return fmt.Errorf("written %d rows but NextCheckPointData is nil", result.Written)
		}

		ridsRaw, ok := result.NextCheckPointData["rids"]
		if !ok {
			return fmt.Errorf("written %d rows but rids not found", result.Written)
		}

		println("DEBUG: updating checkpoint with rids:", ridsRaw)

		if ridsMap, ok := ridsRaw.(map[string]int64); ok {
			println("DEBUG: rids type is map[string]int64, setting...")
			chk.SetRIDs(ridsMap)
			println("DEBUG: checkpoint updated, new rids:", chk.GetRIDs())
			return nil
		}

		if ridsMap, ok := ridsRaw.(map[string]any); ok {
			println("DEBUG: rids type is map[string]any, converting...")
			rids := make(map[string]int64)
			for k, v := range ridsMap {
				switch num := v.(type) {
				case int64:
					rids[k] = num
				case float64:
					rids[k] = int64(num)
				case int:
					rids[k] = int64(num)
				default:
					return fmt.Errorf("invalid RID type %s: %T", k, v)
				}
			}
			chk.SetRIDs(rids)
			println("DEBUG: checkpoint updated, new rids:", chk.GetRIDs())
			return nil
		}

		return fmt.Errorf("rids has unexpected type: %T", ridsRaw)
	}

	println("DEBUG: no rows written, not updating checkpoint")
	return nil
}
