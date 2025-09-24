package config

import (
	"fmt"
	"os"
	"repli/internal/logger"
	"strings"

	"gopkg.in/yaml.v3"
)

type Config struct {
	Replication ReplicationConfig `yaml:"replication"`
	Logging     logger.Config     `yaml:"logging"`
}

type ReplicationConfig struct {
	Sources []SourceSpec `yaml:"sources"`
	Targets []TargetSpec `yaml:"targets"`
	Jobs    []JobSpec    `yaml:"jobs"`
}

type SourceSpec struct {
	Name       string    `yaml:"name"`
	Type       string    `yaml:"type"`
	Connection ConnSpec  `yaml:"connection"`
	Options    DBOptions `yaml:"options,omitempty"`
}

type TargetSpec struct {
	Name       string    `yaml:"name"`
	Type       string    `yaml:"type"`
	Connection ConnSpec  `yaml:"connection"`
	Options    DBOptions `yaml:"options,omitempty"`
}

type ConnSpec struct {
	Scheme   string `yaml:"scheme"`
	Host     string `yaml:"host"`
	Port     int    `yaml:"port"`
	Protocol string `yaml:"protocol"`
}

type DBOptions struct {
	Meta    bool `yaml:"meta"`
	Timeout int  `yaml:"timeout"`
}

type JobSpec struct {
	Name       string     `yaml:"name"`
	Source     string     `yaml:"source"`
	Target     string     `yaml:"target"`
	Kind       string     `yaml:"kind"`
	TableMap   TableMap   `yaml:"table_map"`
	Options    JobOptions `yaml:"options"`
	CheckPoint string     `yaml:"checkpoint"`

	Mode string `yaml:"mode"`
}

type TableMap struct {
	Source  string   `yaml:"source"`
	Target  string   `yaml:"target"`
	Columns []string `yaml:"columns"`
	SeqExpr string   `yaml:"seq_expr"`
}

type JobOptions struct {
	// BatchSize      int `yaml:"`
	// RetryOnFailure bool
	UseMeta bool `yaml:"use_meta"`

	Placement string `yaml:"placement"`
	Affix     string `yaml:"affix"`

	Interval         string `yaml:"interval"`
	Delay            string `yaml:"delay"`
	BatchWindowLimit string `yaml:"batch_window_limit"`
}

type LoggingConfig struct {
	File       string `yaml:"file"`
	Level      string `yaml:"level"`
	MaxSize    int    `yaml:"max_size"`
	MaxAge     int    `yaml:"max_age"`
	MaxBackups int    `yaml:"max_backups"`
	Compress   bool   `yaml:"compress"`
	Mode       string `yaml:"mode"`
}

func Load(filename string) (Config, error) {
	if _, err := os.Stat(filename); os.IsNotExist(err) {
		return Config{}, err
	}

	bdata, err := os.ReadFile(filename)
	if err != nil {
		return Config{}, err
	}

	var cfg Config
	err = yaml.Unmarshal(bdata, &cfg)
	if err != nil {
		return Config{}, err
	}

	if err := cfg.validate(); err != nil {
		return Config{}, err
	}

	return cfg, nil
}

func (c Config) validate() error {
	return nil
}

func (spec *JobSpec) Normalize() {
	if spec.TableMap.SeqExpr == "" {
		// kind가 빈값인경우
		switch strings.ToUpper(spec.Kind) {
		case "TAG":
			spec.TableMap.SeqExpr = "_RID"
		case "LOG":
			spec.TableMap.SeqExpr = "_RID"
		}
	}
	if len(spec.TableMap.Columns) == 0 {
		spec.TableMap.Columns = append(spec.TableMap.Columns, "*")
		return
	}
}

func (spec *JobSpec) Validate() error {
	switch strings.ToUpper(spec.Kind) {
	case "TAG":
	case "LOG":
	default:
		return fmt.Errorf("unknown table %q", spec.Kind)
	}

	return nil
}
