package job

import (
	"context"
	"repli/internal/offset"
	"repli/internal/ports"
)

type ReplicationStrategy interface {
	Execute(ctx context.Context, chk offset.CheckPoint, reader ports.SourceReader, writer ports.TargetWriter) (offset.CheckPoint, error)
}
