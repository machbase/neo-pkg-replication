package ports

import (
	"context"
	"time"
)

type Range struct {
	From time.Time
	To   time.Time
	RIDs map[string]int64 // 임시

	Offset int
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

type WriteConfig struct {
	TableName string
	Columns   []string
	BatchSize int

	// ...
}

type Transformer interface {
	Prepare(ctx context.Context) error
	Transform(ctx context.Context, batch Batch) (Batch, error)
	Close(ctx context.Context) error
}

type Target interface {
	Name() string
	Open(ctx context.Context) error
	Close(ctx context.Context) error
	TableExists(ctx context.Context, table string) (bool, error)
	NewWriter(ctx context.Context, table, seqExpr string, columns []string) (TargetWriter, error)
	// NewWriter(ctx context.Context, spec config.JobSpec) (TargetWriter, error)
}

type TargetWriter interface {
	Prepare(ctx context.Context) error
	WriteBatch(ctx context.Context, batch Batch) (WriteResult, error)
	Close(ctx context.Context) error
}

type MetaWriter interface {
	WriteMeta(ctx context.Context, batch Batch) (int, error)
}

type Describer interface {
	Driver() string                //machbase, postgres
	SupportsKind(kind string) bool // TAG/LOG 등
}

type RangePlanner interface {
	PlanRange(ctx context.Context)
}

// // reader가 읽어서 돌려주는 배치 (필요한 필드만 쓰면 됨)
// type Batch struct {
//     Columns []string
//     Rows    [][]any

//     // 시간 모드용 제안 하이워터마크(없으면 zero)
//     NextTime time.Time

//     // RID 모드용 제안 하이워터마크(단일/샤드)
//     NextRID        int64
//     NextShardRIDs  map[string]int64

//     // 부분성공 시 정확한 커서 계산용(선택)
//     RowTimes []time.Time  // 각 행의 시각
//     RowRIDs  []int64      // 각 행의 RID
// }

// // writer 결과 (부분성공까지 표현)
// type WriteResult struct {
//     Written          int
//     Failed           int
//     LastAppliedIndex int // -1이면 아무 것도 적용 안 됨
// }
