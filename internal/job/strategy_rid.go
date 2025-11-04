package job

import (
	"repli/internal/offset"
	"repli/internal/ports"
	"time"
)

type ridStrategy struct {
	rids map[string]int64
}

func NewRIDStrategy() ReplicationStrategy {
	return &ridStrategy{}
}

func (s *ridStrategy) ShouldReplicate(chk offset.CheckPoint, delay time.Duration) (bool, error) {
	return true, nil
}

func (s *ridStrategy) BuildRange(chk offset.CheckPoint, windowLimit time.Duration) (ports.Range, error) {
	return ports.Range{}, nil
}

func (s *ridStrategy) UpdateCheckPoint(chk *offset.CheckPoint, result ports.WriteResult) error {
	return nil
}

func (s *ridStrategy) NextWindow(rng *ports.Range, windowLimit time.Duration) {

}
