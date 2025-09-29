package ports

import (
	"context"
	"time"
)

type Range struct {
	From time.Time
	To   time.Time
}

type Batch struct {
	Columns []string
	Rows    [][]any

	Meta map[string]any
}

type Source interface {
	Name() string
	Open(ctx context.Context) error
	Close(ctx context.Context) error
	TableExists(ctx context.Context, table string) (bool, error)
	NewReader(ctx context.Context, table, seqExpr string, columns []string) (SourceReader, error)
}

type SourceReader interface {
	Prepare(ctx context.Context) error
	Close(ctx context.Context) error
	ReadRange(ctx context.Context, rng Range) (Batch, error)
}

type MetaReader interface {
	ReadMeta(ctx context.Context, offset int) (Batch, error)
}

type WriteResult struct {
	Written int
	Failed  int
}

type Target interface {
	Name() string
	Open(ctx context.Context) error
	Close(ctx context.Context) error
	TableExists(ctx context.Context, table string) (bool, error)
	NewWriter(ctx context.Context, table, seqExpr string, columns []string) (TargetWriter, error)
}

type TargetWriter interface {
	Prepare(ctx context.Context) error
	WriteBatch(ctx context.Context, batch Batch) (WriteResult, error)
	Close(ctx context.Context) error
}

type MetaWriter interface {
	WriteMeta(ctx context.Context, batch Batch) error
}

type Describer interface {
	Driver() string                //machbase, postgres
	SupportsKind(kind string) bool // TAG/LOG 등
}
