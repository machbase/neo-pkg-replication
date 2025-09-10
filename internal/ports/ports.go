package ports

import "context"

type Source interface {
	Name() string
	Open(ctx context.Context) error
	Close(ctx context.Context) error
	Read(ctx context.Context) ([][]any, error)
}

type Target interface {
	Name() string
	Open(ctx context.Context) error
	Close(ctx context.Context) error
	Write(ctx context.Context, rows [][]any) error
}
