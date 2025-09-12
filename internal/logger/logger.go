package logger

import (
	"bytes"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/sirupsen/logrus"
	"gopkg.in/natefinch/lumberjack.v2"
)

type Config struct {
	Path       string `json:"path"`
	MaxSize    int    `json:"max_size"`
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
	// logger.SetFormatter(&logrus.TextFormatter{
	// 	TimestampFormat: "2006-01-02 15:04:05",
	// 	CallerPrettyfier: func(f *runtime.Frame) (string, string) {
	// 		file := path.Base(f.File)
	// 		return "", fmt.Sprintf("%s:%d", file, f.Line)
	// 	},
	// })
	logger.SetFormatter(&PlainFormatter{
		TimestampFormat: "2006-01-02 15:04:05",
		// CallerPrettyfier: func(f *runtime.Frame) (string, string) {
		// 	file := path.Base(f.File)
		// 	return "", fmt.Sprintf("%s:%d", file, f.Line)
		// },
	})

	lumberjackLogger := &lumberjack.Logger{
		Filename:   cfg.Path,
		MaxSize:    cfg.MaxSize,
		MaxBackups: cfg.MaxBackups,
		MaxAge:     cfg.MaxAge,
		Compress:   cfg.Compress,
	}

	switch strings.ToLower(cfg.Mode) {
	case "debug":
		logger.SetReportCaller(true)
		logger.SetOutput(io.MultiWriter(os.Stdout, lumberjackLogger))
	case "release":
		logger.SetOutput(lumberjackLogger)
	default:
		logger.Warnf("unknown log mode %q, falling back to release mode", cfg.Mode)
		logger.SetOutput(lumberjackLogger)
	}

	return logger
}

type PlainFormatter struct {
	TimestampFormat string
}

func (p *PlainFormatter) Format(entry *logrus.Entry) ([]byte, error) {
	out := entry.Buffer
	if out == nil {
		b := &bytes.Buffer{}
		entry.Buffer = b
	} else {
		out.Reset()
	}

	out.WriteByte('[')
	out.WriteString(shortLevel(entry.Level))
	out.WriteByte(']')
	out.WriteByte(' ')

	if p.TimestampFormat == "" {
		p.TimestampFormat = time.RFC3339
	}
	out.WriteString(entry.Time.Format(p.TimestampFormat))
	out.WriteByte(' ')

	if entry.HasCaller() {
		out.WriteString(filepath.Base(entry.Caller.File))
		out.WriteByte(':')
		out.WriteString(strconv.Itoa(entry.Caller.Line))
		out.WriteByte(' ')
	}

	if v, ok := entry.Data["runner"]; ok {
		out.WriteByte('(')
		switch rv := v.(type) {
		case string:
			out.WriteString(rv)
		default:
			fmt.Fprint(out, rv)
		}
		out.WriteByte(')')
		out.WriteByte(' ')
	}

	out.WriteString(entry.Message)
	out.WriteByte('\n')

	return out.Bytes(), nil
}

func shortLevel(l logrus.Level) string {
	switch l {
	case logrus.InfoLevel:
		return "INFO"
	case logrus.ErrorLevel:
		return "ERRO"
	case logrus.WarnLevel:
		return "WARN"
	case logrus.DebugLevel:
		return "DEBU"
	case logrus.TraceLevel:
		return "TRAC"
	case logrus.FatalLevel:
		return "FATA"
	case logrus.PanicLevel:
		return "PANI"
	default:
		s := strings.ToUpper(l.String())
		if len(s) >= 4 {
			return s[:4]
		}
		return s
	}
}
