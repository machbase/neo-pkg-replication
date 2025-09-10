package config

import (
	"fmt"
	"os"

	"gopkg.in/yaml.v3"
)

type Config struct {
	Replication ReplicationConfig `yaml:"replication"`
	Logging     LoggingConfig     `yaml:"logging"`
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
	Protocol string `yaml:"rest"`
}

type DBOptions struct {
	Meta    bool `yaml:"meta"`
	Timeout int  `yaml:"timeout"`
}

type JobSpec struct {
	Name       string     `yaml:"name"`
	Source     string     `yaml:"source"`
	Target     string     `yaml:"target"`
	Mode       string     `yaml:"mode"`
	TableMap   []TableMap `yaml:"table_map"`
	Options    JobOptions `yaml:"options"`
	CheckPoint string     `yaml:"checkpoint"`
}

type TableMap struct {
	Source  string   `yaml:"source"`
	Target  string   `yaml:"target"`
	Columns []string `yaml:"columns"`
}

type JobOptions struct {
	// BatchSize      int `yaml:"`
	// RetryOnFailure bool

	Interval  string `yaml:"interval"`
	Delay     string `yaml:"delay"`
	RateLimit int    `yaml:"rate_limit"`
}

type LoggingConfig struct {
	Level string `yaml:"level"`
	File  string `yaml:"file"`
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

	fmt.Printf("config: %v\n", cfg)

	return cfg, nil
}

func (c Config) validate() error {

	return nil
}
