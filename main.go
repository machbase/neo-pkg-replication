package main

type Config struct {
	Replication ReplicationConfig `yaml:"replication"`
	Logging     LoggingConfig     `yaml:"logging"`
}

type ReplicationConfig struct {
	Sources         []DBConfig
	Targets         []DBConfig
	ReplicationJobs []ReplicationJob
}

type DBConfig struct {
	Name       string
	Type       string
	Connection DBConnection
	Options    DBOptions
}

type DBConnection struct {
	Host      string
	Port      int
	TableName string
	Protocol  string
}

type DBOptions struct {
	UseMeta bool
	Timeout int
}

type ReplicationJob struct {
	Name    string
	Source  string
	Target  string
	Tables  []string
	Mode    string
	Options JobOptions
}

type JobOptions struct {
	BatchSize      int
	RetryOnFailure bool

	Interval  string
	Delay     string
	RateLimit int
}

type LoggingConfig struct {
	Level string
	File  string
}

// type Config struct {
// 	Source []SourceInfo `json:"source"`
// 	Target []TargetInfo `json:"target"`
// }

// type SourceInfo struct {
// 	TargetName string // machbase-neo3

// 	TableInfo

// 	AttachMent string // prefix, suffix, regexp

// 	Interval  string // 10m
// 	Delay     string // 1m
// 	RateLimit string // 3m

// 	Sequence string // default : TO_TIMESTAMP(TIME)
// }

// type TargetInfo struct {
// 	Name string // machbase-neo3

// 	TableInfo

// 	UseMeta  bool
// 	UseToken bool // Neo token
// }

// type TableInfo struct {
// 	TableName string
// 	IP        string
// 	Port      int
// 	Protocol  string // REST, CGO, GRPC, CLI
// }

type Source interface {
	Read() ([][]any, error)
}

type Transform interface {
}

type Target interface {
	Write([][]any) error
}

func main() {

	// config Load
	//

	// var errCh := make(chan error, 4)
	// replicationNEO= func(source, target ) {
	// if err := repli(source, target); err !=nil {
	// errCh <- err
	// }
	// }

	// for _, := range sources{
	// replicationNEO(source1, target1)
	// replicationNEO(source2, target2)
	// replicationNEO(source3, target3)
	// replicationNEO(source4, target4)
	// }

	// defer func () {close(errCh)}()

	// for err := errCh {
	// if err != nil {
	// return err
	// }
	// }

}
