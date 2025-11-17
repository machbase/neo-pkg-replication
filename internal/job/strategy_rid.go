package job

import (
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

func (s *ridStrategy) ShouldReplicate(chk offset.CheckPoint) (bool, error) {
	rids := chk.GetRIDs()
	if len(rids) > 0 {
		return true, nil
	} else {
		return false, nil // rid 재조회 필요
	}
}

func (s *ridStrategy) BuildRange(chk offset.CheckPoint) (ports.Range, error) {
	rids := chk.GetRIDs()
	if rids == nil {
		rids = make(map[string]int64)
	}

	return ports.Range{
		From: time.Time{},
		To:   time.Time{},
		RIDs: rids,
	}, nil
}

// 프로그램 최초 실행,   숫자는 Unmarshal 시 float64
// 프로그램 실행 중,    메모리에서는 int64
func (s *ridStrategy) UpdateCheckPoint(chk *offset.CheckPoint, result ports.WriteResult) error {
	if result.Written > 0 {
		if result.NextCheckPointData == nil {
			return fmt.Errorf("written %d rows but NextCheckPointData is nil", result.Written)
		}

		ridsRaw, ok := result.NextCheckPointData["rids"]
		if !ok {
			return fmt.Errorf("written %d rows but rids not found", result.Written)
		}

		if ridsMap, ok := ridsRaw.(map[string]int64); ok {
			chk.SetRIDs(ridsMap)
			return nil
		}

		if ridsMap, ok := ridsRaw.(map[string]any); ok {
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
			return nil
		}

		return fmt.Errorf("rids has unexpected type: %T", ridsRaw)
	}

	return nil
}

func (s *ridStrategy) NextWindow(rng *ports.Range) {
}
