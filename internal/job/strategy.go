package job

import (
	"repli/internal/offset"
	"repli/internal/ports"
	"time"
)

type ReplicationStrategy interface {
	ShouldReplicate(chk offset.CheckPoint, delay time.Duration) (bool, error)
	BuildRange(chk offset.CheckPoint, windowLimit time.Duration) (ports.Range, error)
	UpdateCheckPoint(chk *offset.CheckPoint, result ports.WriteResult) error
	NextWindow(rng *ports.Range, windowLimit time.Duration)
}
