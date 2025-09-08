package logger

import (
	"io"
	"os"
	"strings"

	"github.com/sirupsen/logrus"
	"gopkg.in/natefinch/lumberjack.v2"
)

type Config struct {
	Path       string `json:"path"`
	MaxSize    int    `json:"max_size"` // MB
	MaxBackups int    `json:"max_backups"`
	MaxAge     int    `json:"max_age"`
	Compress   bool   `json:"compress"`
	Level      string `json:"level"`
	Mode       string `json:"mode"`
}

func New(cfg Config) *logrus.Logger {
	logger := logrus.New()

	level, err := logrus.ParseLevel(cfg.Level)
	if err != nil {
		logger.Warnf("invalid log level %q, falling back to 'Info' Level", cfg.Level)
		level = logrus.InfoLevel
	}
	logger.SetLevel(level)

	lumberjackLogger := &lumberjack.Logger{
		Filename:   cfg.Path,
		MaxSize:    cfg.MaxSize,
		MaxBackups: cfg.MaxBackups,
		MaxAge:     cfg.MaxAge,
		Compress:   cfg.Compress,
	}

	switch strings.ToLower(cfg.Mode) {
	case "debug":
		logger.SetReportCaller(false)
		logger.SetFormatter(&logrus.JSONFormatter{
			TimestampFormat: "2006-01-02 15:04:05",
		})
		logger.SetOutput(io.MultiWriter(os.Stdout, lumberjackLogger))
	case "release":
		logger.SetReportCaller(true)
		logger.SetFormatter(&logrus.JSONFormatter{
			TimestampFormat: "2006-01-02 15:04:05",
		})
		logger.SetOutput(lumberjackLogger)
	default:
		logger.Warnf("unknown log mode %q, falling back to release mode", cfg.Mode)
		logger.SetOutput(lumberjackLogger)
	}

	return logger
}
