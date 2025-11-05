package job

import (
	"repli/internal/offset"
	"repli/internal/ports"
)

type ReplicationStrategy interface {
	ShouldReplicate(chk offset.CheckPoint) (bool, error)
	BuildRange(chk offset.CheckPoint) (ports.Range, error)
	UpdateCheckPoint(chk *offset.CheckPoint, result ports.WriteResult) error
	NextWindow(rng *ports.Range)
}
