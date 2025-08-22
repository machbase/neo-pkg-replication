package source

type Source interface {
	Read() ([][]any, error)
}

type source struct {
}

func (s *source) Read() ([][]any, error) {
	return nil, nil
}

func New() (Source, error) {
	return &source{}, nil
}
