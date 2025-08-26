package target

import (
	"repli/common"
	"repli/config"
)

type target struct {
	cfg config.DBConfig
}

func (t *target) Write(data [][]any) error {
	return nil
}

func (t *target) Close() error {
	return nil
}

// func (t *target) Lookup(name string) (config.DBConfig, bool) {
// 	if cfg, ok := t.dbConfigsByMap[name]; ok {
// 		return cfg, true
// 	}
// 	return config.DBConfig{}, false
// }

func (tar *target) List() {
	// for _, cfg := range tar.dbConfigs {
	// 	fmt.Println("target config: ", cfg)
	// }
}

func New(dbConfigs ...config.DBConfig) ([]Target, error) {
	if err := common.ValidateNoDuplicateNames(dbConfigs...); err != nil {
		return nil, err
	}

	targets := make([]Target, len(dbConfigs))
	for _, cfg := range dbConfigs {
		tar := &target{cfg: cfg}
		targets = append(targets, tar)
	}

	return targets, nil
}
