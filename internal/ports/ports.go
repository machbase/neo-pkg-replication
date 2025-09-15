package ports

import "context"

type Source interface {
	Name() string
	Open(ctx context.Context) error
	Close(ctx context.Context) error
	Read(ctx context.Context) ([][]any, error)

	NewReader(ctx context.Context) ([][]any, error)
}

type SourceReader interface {
	Prepare(ctx context.Context) error
	Close(ctx context.Context) error
	ReadBatch(ctx context.Context) ([][]any, error)
}

type Target interface {
	Name() string
	Open(ctx context.Context) error
	Close(ctx context.Context) error
	Write(ctx context.Context, rows [][]any) error

	NewWriter(ctx context.Context) error
}

type TargetWriter interface {
	Prepare(ctx context.Context)
	WriteBatch(ctx context.Context, rows [][]any) error
	Close(ctx context.Context) error
}

type Describer interface {
	Driver() string                //machbase, postgres
	SupportsKind(kind string) bool // TAG/LOG 등
}
