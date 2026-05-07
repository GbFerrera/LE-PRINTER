# Link Eats - Impressora de Pedidos

Aplicativo Electron para recebimento automático de pedidos via WebSocket e impressão térmica.

## Funcionalidades

- 🔐 **Login seguro** com token de autenticação
- 🌐 **Conexão WebSocket** para recebimento de pedidos em tempo real
- 🖨️ **Impressão automática** configurável
- 📋 **Lista de pedidos pendentes** para impressão manual
- ⚙️ **Configurações persistentes** (credenciais e preferências)
- 🧪 **Teste de impressora** integrado

## Pré-requisitos

- Node.js 16+ instalado
- Python 3.7+ instalado
- Impressora compatível com Windows (qualquer impressora instalada no sistema)
- Driver da impressora instalado no sistema
- Biblioteca Python pywin32 (instalada automaticamente)

## Instalação

1. Clone ou baixe o projeto:
```bash
cd electron-printer-app
```

2. Instale as dependências Node.js:
```bash
npm install
```

3. Instale as dependências Python:
```bash
pip install -r requirements.txt
```

4. Execute o aplicativo:
```bash
npm start
```

## Desenvolvimento

Para executar em modo de desenvolvimento:
```bash
npm run dev
```

## Build

Para gerar executável:  
```bash
npm run build
```

O executável será gerado na pasta `dist/`.

## Configuração

### WebSocket

O aplicativo se conecta a um servidor WebSocket que deve enviar mensagens no formato:

```json
{
  "type": "new_order",
  "data": {
    "id": "12345",
    "customer_name": "João Silva",
    "phone": "(11) 99999-9999",
    "created_at": "2024-01-01T12:00:00Z",
    "total": "25.90",
    "items": [
      {
        "name": "Pizza Margherita",
        "quantity": 1,
        "price": "25.90",
        "observations": "Sem cebola"
      }
    ],
    "delivery_address": "Rua das Flores, 123",
    "observations": "Entregar no portão"
  }
}
```

### Impressora

O aplicativo utiliza um motor de impressão Python baseado em `pywin32` e suporta:
- Qualquer impressora instalada no Windows
- Impressoras térmicas
- Impressoras convencionais
- Impressoras de rede

#### Configuração da Impressora

1. Instale o driver da impressora no sistema Windows
2. Configure a impressora como padrão (recomendado) ou anote o nome exato
3. Execute o teste de impressora no aplicativo para verificar funcionamento

## Uso

1. **Login**: Insira a URL do WebSocket e o token de autenticação
2. **Configuração**: Ative/desative a impressão automática conforme necessário
3. **Monitoramento**: Acompanhe os pedidos recebidos em tempo real
4. **Impressão**: 
   - Automática: Pedidos são impressos imediatamente ao chegar
   - Manual: Pedidos ficam na lista para impressão posterior

## Estrutura do Projeto

```
electron-printer-app/
├── main.js           # Processo principal do Electron
├── preload.js        # Script de preload para comunicação segura
├── index.html        # Interface do usuário
├── styles.css        # Estilos da aplicação
├── renderer.js       # Lógica da interface
├── printer.py        # Motor de impressão Python
├── package.json      # Configurações e dependências Node.js
├── requirements.txt  # Dependências Python
└── README.md         # Este arquivo
```

## Troubleshooting

### Problemas de Conexão WebSocket

- Verifique se a URL está correta (deve começar com `ws://` ou `wss://`)
- Confirme se o token de autenticação é válido
- Teste a conectividade de rede

### Problemas de Impressão

- Verifique se a impressora está ligada e conectada
- Confirme se o driver está instalado corretamente
- Execute o teste de impressora no aplicativo
- Verifique se há papel na impressora
- Certifique-se de que o Python está instalado e acessível via linha de comando
- Verifique se a biblioteca pywin32 foi instalada corretamente: `pip list | grep pywin32`

### Problemas com Python

- Verifique se o Python está no PATH do sistema
- No Windows, teste executando `python --version` no terminal
- Se necessário, reinstale as dependências: `pip install --upgrade -r requirements.txt`
- O aplicativo requer Windows para funcionar (devido ao pywin32)

### Erro de Permissões

No macOS, pode ser necessário dar permissões para:
- Acesso à rede
- Acesso à impressora
- Execução de aplicativos de terceiros

## Suporte

Para suporte técnico, entre em contato com a equipe de desenvolvimento do Link Eats.

## Licença

MIT License - Veja o arquivo LICENSE para detalhes.