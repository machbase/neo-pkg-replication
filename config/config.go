package config

import (
	"os"

	"gopkg.in/yaml.v3"
)

type Config struct {
	Replication ReplicationConfig `yaml:"replication"`
	Logging     LoggingConfig     `yaml:"logging"`
}

type ReplicationConfig struct {
	Sources         []DBConfig       `yaml:"sources"`
	Targets         []DBConfig       `yaml:"targets"`
	ReplicationJobs []ReplicationJob `yaml:"replication_jobs"`
}

type DBConfig struct {
	Name       string       `yaml:"name"`
	Type       string       `yaml:"type"`
	Connection DBConnection `yaml:"connection"`
	Options    DBOptions    `yaml:"options,omitempty"`
}

type DBConnection struct {
	Host     string `yaml:"host"`
	Port     int    `yaml:"port"`
	Protocol string `yaml:"rest"`
}

type DBOptions struct {
	Meta    bool `yaml:"meta"`
	Timeout int  `yaml:"timeout"`
}

type ReplicationJob struct {
	Name    string        `yaml:"name"`
	Source  string        `yaml:"source"`
	Target  string        `yaml:"target"`
	Mode    string        `yaml:"mode"`
	Tables  []TableOption `yaml:"tables"`
	Options JobOptions    `yaml:"options"`
}

type TableOption struct {
	Name    string   `yaml:"name"`
	Columns []string `yaml:"columns,omitempty"`
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

	return cfg, nil
}
