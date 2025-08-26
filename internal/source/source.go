package source

import (
	"repli/common"
	"repli/config"
)

type Source interface {
	// Connect() ()
	Read() ([][]any, error)
	Close() error

	List() // test
}

type source struct {
	cfg config.DBConfig
}

func (s *source) Read() ([][]any, error) {
	return nil, nil
}
func (s *source) Close() error {
	return nil
}

// func (s *source) Lookup(name string) (config.DBConfig, bool) {
// 	if cfg, ok := s.dbConfigsByMap[name]; ok {
// 		return cfg, true
// 	}
// 	return config.DBConfig{}, false
// }

func (s *source) List() {

}

func New(dbConfigs ...config.DBConfig) ([]Source, error) {
	if err := common.ValidateNoDuplicateNames(dbConfigs...); err != nil {
		return nil, err
	}

	sources := make([]Source, len(dbConfigs))

	for _, cfg := range dbConfigs {
		src := &source{cfg: cfg}
		sources = append(sources, src)
	}

	return sources, nil
}
